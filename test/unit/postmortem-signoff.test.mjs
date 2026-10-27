// Persisted lessons need a person's sign-off; pending text stays reviewable in the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, runner } from "../fixtures/workers/run.mjs";

const { handleToolCall } = await import("../../dist/tools.js");
const { concludePostmortem, signOffPostmortem } = await import("../../dist/postmortem/meeting.js");
const { addLessons, activeLessons, isLegacyLesson, contractLessons, cardSection, ultraplanSection } = await import("../../dist/postmortem/lessons.js");
const { loadLessons, pendingPostmortems, loadRecord, saveRecord, lessonsPath, memoryPath, recordPath } = await import("../../dist/postmortem/store.js");
const { renderRecord } = await import("../../dist/postmortem/record.js");
const { parseArtifactBlock } = await import("../../dist/postmortem/artifacts.js");
const { newId } = await import("../../dist/ids.js");
const { AGENTS_DIR, AUDIT_DIR } = await import("../../dist/config.js");
const { runDoctor, formatDoctor } = await import("../../dist/cli-up.js");
const entry = new URL("../../dist/index.js", import.meta.url).pathname;
const ok = async (args) => {
  const result = await handleToolCall("postmortem", args);
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const auditFor = (pm) => readdirSync(AUDIT_DIR).flatMap((n) => readFileSync(join(AUDIT_DIR, n), "utf8").split("\n").filter(Boolean).map(JSON.parse)).filter((e) => e.action === "postmortem.applied" && e.target === pm);

async function held({ execution = false, flagged = false } = {}) {
  const repo = execution ? await makeRun({ contract: { postmortem: { enabled: true } } }) : makeRepo();
  const { project } = await ok({ action: "enable", project: repo.root, reason: "Hold postmortem meetings" });
  const pm = newId("pm");
  const agent = `review-${pm.slice(3)}`;
  mkdirSync(AGENTS_DIR, { recursive: true });
  const persona = join(AGENTS_DIR, `${agent}.md`);
  writeFileSync(persona, `---\nname: ${agent}\ndescription: Review persona\n---\nCheck the work.\n`);
  const finding = "pmf-00000001";
  const kinds = ["rule", "agent_rule", "contract_rule", "persona_addendum", "memory", "fix"];
  const { artifacts } = parseArtifactBlock(kinds.map((kind) => `Artifact: ${kind} | ${kind === "fix" ? "src/review.ts" : ["rule", "contract_rule"].includes(kind) ? "project" : agent} | ${finding} | Review ${kind} text`).join("\n"), [agent], new Set([finding]));
  const rec = {
    v: 1, pm, project, scope: execution ? { execution_id: repo.store.id } : { work: "Review" },
    status: "held", created: new Date().toISOString(), held_at: new Date().toISOString(), format: "collaborate", rounds: 1,
    seats: ["orchestrator", agent], refs: { [agent]: persona }, session: "review", memory_target: "claude",
    opening: "Review the checks", findings: [{ id: finding, summary: "The checks need clearer criteria", detected_by: "review", responsible: [agent], category: flagged ? "contract_ambiguity" : "implementation", at: new Date().toISOString() }],
    transcript: [], proposed: artifacts, rejected_lines: [],
  };
  saveRecord(rec, renderRecord(rec));
  if (execution) await repo.store.transact(() => ({ events: [{ type: "postmortem.started", source: runner, payload: { id: pm, format: rec.format, seats: rec.seats } }] }));
  return { repo, project, pm, agent, persona, rec };
}

test("unsigned persisted kinds stay pending, write no effects and never enter plan, card or ultraplan sections", async () => {
  const { repo, project, pm, agent, persona } = await held();
  const before = readFileSync(persona, "utf8");
  const result = await concludePostmortem({ pm, closing: "Ready for review", accept: ["a1", "a2", "a3", "a4", "a5", "a6"] });
  assert.deepEqual(result.pending, ["a1", "a2", "a3", "a4", "a5"]);
  assert.equal(result.lessons_added, 0);
  assert.equal(existsSync(lessonsPath(project)), false);
  assert.equal(readFileSync(persona, "utf8"), before);
  assert.equal(existsSync(memoryPath(project, agent)), false);
  assert.equal(existsSync(join(repo.root, ".claude", "agent-memory")), false);
  assert.equal(contractLessons(repo.root), undefined);
  assert.equal(cardSection(repo.root, agent), "");
  assert.equal(ultraplanSection(repo.root), "");
  assert.deepEqual(auditFor(pm).map((a) => a.details.kind), ["fix"]);
  const pending = await ok({ action: "pending", project: repo.root });
  assert.equal(pending.pending.length, 5);
  assert.deepEqual(Object.keys(pending.pending[0]), ["pm", "id", "kind", "target", "text", "hash"]);
  assert.equal((await ok({ action: "lessons", project: repo.root })).pending, 5);
  const md = readFileSync(recordPath(project, pm, "md"), "utf8");
  assert.match(md, /## Pending sign-off/);
  assert.match(md, /Review memory text/);
  assert.ok(loadRecord(project, pm).applied.filter((a) => a.id !== "a6").every((a) => a.note === "pending sign-off"));
});

test("sign-off applies exactly selected ids, records signer and time, and retries do not reapply", async () => {
  const { project, pm, agent, repo, persona } = await held();
  await concludePostmortem({ pm, closing: "Review", accept: ["a1", "a2", "a3", "a4", "a5"] });
  for (const accept of [[], ["missing"], ["a1", "a6"]]) {
    await assert.rejects(signOffPostmortem({ pm, orchestrator: "Reviewer", accept }), /at least one|missing|a6/);
  }
  assert.equal(loadLessons(project).length, 0, "invalid lists are refused before any listed id is applied");
  const result = await ok({ action: "signoff", pm, orchestrator: " Reviewer ", accept: ["a1", "a3"] });
  assert.deepEqual(result.pending, ["a2", "a4", "a5"]);
  assert.deepEqual(loadLessons(project).map((l) => l.kind).sort(), ["contract_rule", "rule"]);
  const signed = result.applied.filter((a) => a.signoff);
  assert.equal(signed.length, 2);
  for (const done of signed) {
    assert.equal(done.signoff.by, "Reviewer");
    assert.ok(Number.isFinite(Date.parse(done.signoff.at)));
    const audit = auditFor(pm).find((a) => a.details.artifact === done.id);
    assert.equal(audit.details.signed_off_by, "Reviewer");
    assert.equal(audit.details.signed_off_at, done.signoff.at);
    assert.equal(audit.details.hash, done.hash);
    assert.ok(loadLessons(project).some((l) => l.signoff.by === "Reviewer" && l.signoff.at === done.signoff.at));
  }
  assert.equal(existsSync(memoryPath(project, agent)), false);
  assert.doesNotMatch(readFileSync(persona, "utf8"), /Postmortem addenda/);
  assert.match(cardSection(repo.root, agent), /Review rule text/);
  assert.doesNotMatch(cardSection(repo.root, agent), /Review agent_rule text/);
  assert.match(contractLessons(repo.root).decisions[0].text, /Review contract_rule text/);
  const count = auditFor(pm).length;
  const again = await signOffPostmortem({ pm, orchestrator: "Reviewer", accept: ["a1", "a3"] });
  assert.deepEqual(again.already_signed_off, ["a1", "a3"]);
  assert.equal(auditFor(pm).length, count);
  assert.equal(loadLessons(project).length, 2);
  await signOffPostmortem({ pm, orchestrator: "Reviewer", accept: ["a2", "a4", "a5"] });
  assert.match(readFileSync(persona, "utf8"), /Review persona_addendum text/);
  assert.match(readFileSync(memoryPath(project, agent), "utf8"), /Review memory text/);
  assert.match(readFileSync(join(repo.root, ".claude", "agent-memory", agent, "MEMORY.md"), "utf8"), /Review memory text/);
  assert.deepEqual(pendingPostmortems(project), []);
});

test("a signed conclusion applies only listed ids and flags use only signed-off wording", async () => {
  const unsigned = await held({ flagged: true });
  const pending = await concludePostmortem({ pm: unsigned.pm, closing: "Review", accept: ["a1", "a6"] });
  assert.equal(pending.flagged[0].clearer, undefined);
  assert.doesNotMatch(loadLessons(unsigned.project)[0].text, /Review rule|Review fix/);
  const signed = await held({ flagged: true });
  const result = await concludePostmortem({ pm: signed.pm, closing: "Approved", orchestrator: "Reviewer", accept: ["a1"] });
  assert.deepEqual(result.pending, []);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].signoff.by, "Reviewer");
  assert.equal(result.flagged[0].clearer, "Review rule text");
  assert.deepEqual(loadLessons(signed.project).map((l) => l.kind).sort(), ["flag", "rule"]);
});

test("identity is bounded and execution sign-off must match the frozen contract before any effects", async () => {
  const { repo, project, pm } = await held({ execution: true });
  for (const orchestrator of ["other", " ", "x".repeat(201)]) {
    await assert.rejects(concludePostmortem({ pm, closing: "Review", orchestrator, accept: ["a1"] }), /orchestrator/);
    assert.equal(loadRecord(project, pm).status, "held");
    assert.equal(loadLessons(project).length, 0);
  }
  await concludePostmortem({ pm, closing: "Review", accept: ["a1", "a2"] });
  assert.equal(loadRecord(project, pm).contract_orchestrator, "main");
  await assert.rejects(signOffPostmortem({ pm, orchestrator: "other", accept: ["a1"] }), /orchestrator/);
  // The identity check uses the record's snapshot, so it survives the run being purged.
  const gone = loadRecord(project, pm);
  gone.scope = { execution_id: "exe-0000000000000000" };
  saveRecord(gone, renderRecord(gone));
  await assert.rejects(signOffPostmortem({ pm, orchestrator: "other", accept: ["a1"] }), /orchestrator must equal/);
  gone.scope = { execution_id: repo.store.id };
  saveRecord(gone, renderRecord(gone));
  const result = await signOffPostmortem({ pm, orchestrator: "main", accept: ["a1"] });
  assert.deepEqual(result.pending, ["a2"]);
  const state = await repo.store.state();
  const blob = await repo.store.getBlob(state.postmortem.meetings[pm].concluded.record);
  assert.match(blob.toString(), /signed off by main/);
  assert.match(blob.toString(), /## Pending sign-off/);
  assert.equal((await repo.store.verify()).ok, true);
});

test("legacy lessons keep flowing, are marked in views, and doctor suggests an informational review", async () => {
  const { repo, project, pm, rec } = await held();
  addLessons(project, ["rule", "contract_rule", "agent_rule"].map((kind) => ({ kind, target: kind === "agent_rule" ? rec.seats[1] : "project", text: `Legacy ${kind}`, pm, findings: [] })));
  assert.ok(activeLessons(project).every(isLegacyLesson));
  assert.match(cardSection(repo.root, rec.seats[1]), /Legacy rule/);
  assert.match(ultraplanSection(repo.root), /Legacy agent_rule/);
  assert.match(contractLessons(repo.root).decisions[0].text, /Legacy contract_rule/);
  const view = await ok({ action: "lessons", project: project });
  assert.ok([view.rules[0], view.contract_rules[0], view.agent_rules[0]].every((l) => l.accepted_before_signoff === true));
  assert.match(renderRecord({ ...rec, status: "concluded", accepted: ["a1"], applied: [{ ...rec.proposed[0], note: "added" }] }), /accepted before sign-off/);
  await concludePostmortem({ pm, closing: "Review", accept: ["a1"] });
  const doctor = await runDoctor({ nodeVersion: "24.0.0", engines: ">=22", providers: () => ["test"], keyNames: {}, findExecutable: () => "found", roundtableBin: () => ({ path: null, ours: false }), runtimes: [], docker: async () => ({ ok: true }), chrome: () => "found" });
  assert.equal(doctor.ok, true);
  const notice = doctor.checks.find((c) => c.id === `postmortem-${project}`);
  assert.equal(notice.ok, true);
  assert.equal(notice.essential, false);
  assert.match(formatDoctor(doctor), /3 accepted before sign-off; 1 pending/);
  assert.match(notice.detail, /roundtable postmortem pending/);
});

test("CLI pending and signoff review and apply explicit ids, with usage and refusal exit codes", async () => {
  const { repo, project, pm } = await held();
  await concludePostmortem({ pm, closing: "Review", accept: ["a1", "a2"] });
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [entry, "postmortem", ...args, "--json"], { encoding: "utf8" }));
  assert.equal(cli("pending", "--project", repo.root).pending.length, 2);
  assert.deepEqual(cli("signoff", pm, "--by", "CLI reviewer", "a1").pending, ["a2"]);
  assert.equal(loadLessons(project)[0].signoff.by, "CLI reviewer");
  assert.equal(cli("signoff", pm, "a1", "--by", "CLI reviewer").already_signed_off[0], "a1");
  assert.equal(spawnSync(process.execPath, [entry, "postmortem", "signoff", pm], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [entry, "postmortem", "signoff", pm, "--by", "CLI reviewer", "a99"], { encoding: "utf8" }).status, 1);
});
