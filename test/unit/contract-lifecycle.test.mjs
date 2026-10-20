// Contract lifecycle (heads-down.md §8): structure sources, propose, consent, freeze, amend, and the tool layer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { json, stubFetch } from "./helpers.mjs";

const { proposeContract, freezeContract, amendContract, fileDissent, resolveRepo, AuthorityError, ContractRefusal, authorityNeeds } =
  await import("../../dist/execution/contract-lifecycle.js");
const { contractRecord, openContractStore, summarizeConsent, consentRoundStaleMs, endConsentRound, CONSENT_ROUND_STALE_CAP_MS } = await import("../../dist/execution/contract-state.js");
const { requestConsent } = await import("../../dist/execution/consent.js");
const { buildConsentPrompt, CONSENT_REASK, consentReason } = await import("../../dist/execution/consent.js");
const { findTaskBlock, blockToContract, sessionSource, TASK_BLOCK_TAG } = await import("../../dist/execution/contract-parse.js");
const { contractHash, consentHash, checkContract } = await import("../../dist/execution/contract.js");
const { listExecutions } = await import("../../dist/execution/store.js");
const { archiveSession } = await import("../../dist/sessions/archive.js");
const { lockSession } = await import("../../dist/sessions/lock.js");
const { handleToolCall, tools } = await import("../../dist/tools.js");
const { AUDIT_DIR } = await import("../../dist/config.js");

const LLM = "http://localhost:4141/v1";
const llm = { provider: "openai_compatible", model: "m", baseUrl: LLM };
const fixture = (name) => fileURLToPath(new URL(`../fixtures/ultraplan/${name}.md`, import.meta.url));
const cfo = fixture("cfo");
const skeptic = fixture("skeptic");
const ops = fixture("ops");

// A throwaway git repository with one commit.
const repoDir = mkdtempSync(join(tmpdir(), "rt-contract-repo-"));
const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repoDir, encoding: "utf8" }).trim();
git("init", "-q");
mkdirSync(join(repoDir, "src"));
writeFileSync(join(repoDir, "README.md"), "orders\n");
git("add", ".");
git("commit", "-q", "-m", "init");
const headSha = git("rev-parse", "HEAD");
after(() => rmSync(repoDir, { recursive: true, force: true }));

const agentOf = (body) => /You are (\w+)\./.exec(body.messages[0].content)?.[1].toLowerCase();
/** Stub the provider: script(agent, body, index) returns the reply text (or a Response). */
function provider(t, script) {
  return stubFetch(t, async (url, init, i) => {
    assert.equal(url, `${LLM}/chat/completions`, `unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    const out = await script(agentOf(body), body, i);
    return out instanceof Response ? out : json(200, { choices: [{ message: { content: out } }] });
  });
}
/** Replies per agent, in order; any other call fails the test. */
const answers = (map) => (agent) => {
  const list = map[agent];
  assert.ok(list?.length, `unexpected provider call for ${agent}`);
  return list.shift();
};

const baseTasks = () => [
  { id: "api", title: "Orders API", persona: cfo, paths: { write: ["src/api/**"] }, acceptance: ["GET /orders works"], checks: ["test"] },
  { id: "ui", title: "Orders page", persona: skeptic, depends_on: ["api"], paths: { write: ["src/ui/**"] }, acceptance: ["renders orders"], checks: ["test"] },
];
const explicit = (over = {}) => ({
  tasks: baseTasks(),
  validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 60 }] },
  interfaces: [{ name: "OrdersApi", kind: "api", owner: "api", consumers: ["ui"], description: "GET /orders" }],
  decisions: [{ id: "d1", text: "REST, not GraphQL" }],
  budget: { usd: 10, per_task_usd: 5, wall_clock_min: 30 },
  ...over,
});
const propose = (over = {}) => proposeContract({
  goal: "Ship the orders page", orchestrator: "main", originalPrompt: "please ship the orders page", repoDir, contract: explicit(), llm, ...over,
});
const blockText = (structure) => `Plan prose.\n\n\`\`\`${TASK_BLOCK_TAG}\n${JSON.stringify(structure, null, 2)}\n\`\`\`\n`;
const auditEntries = () => {
  try {
    return readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(AUDIT_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  } catch {
    return [];
  }
};
const consentRequests = (calls) => calls.filter((c) => c.body.messages.at(-1).content.includes("Consent: AGREE"));

const concern = (over = {}) => ({
  id: "empty-state-risk", by: skeptic, source: { kind: "manual" },
  claim: "The empty state may fail.", predicted_failure: "The page check fails with no orders.",
  tripwire: { kind: "check_failed", check: "test", task: "ui" }, ...over,
});

async function draftAgent(store, agent = skeptic) {
  const { tokenSha256 } = await import("../../dist/workers/files.js");
  const token = "ab".repeat(32);
  const source = { kind: "runner", id: "runner", pid: process.pid };
  await store.transact(() => ({ events: [{ type: "agent.registered", source,
    payload: { agent, persona: agent, driver: "claude-code", token_sha256: tokenSha256(token), external: true } }] }));
  return { execution_id: store.id, agent_token: token };
}

test("file_dissent files and updates drafts, validates data, and rejects frozen contracts and unauthorized callers", async (t) => {
  const r = await propose();
  const store = await openContractStore(r.contractId);
  const args = { contract_id: r.contractId, orchestrator: "main", dissent: concern() };
  const filed = await handleToolCall("file_dissent", args);
  assert.equal(filed.isError, undefined, filed.content[0].text);
  let rec = await contractRecord(store);
  assert.equal(rec.version, 2);
  assert.equal(rec.contract.dissents[0].on_fire, "huddle");
  assert.notEqual(consentHash(r.contract), rec.hash);
  assert.match(readFileSync(join(store.dir, "contracts", r.contractId, "CONTRACT.md"), "utf8"), /empty-state-risk/);
  const updated = await fileDissent(store, concern({ on_fire: "notify" }), { by: "main" });
  assert.equal(updated.version, 3);
  assert.equal(updated.contract.dissents.length, 1);
  assert.equal(updated.contract.dissents[0].on_fire, "notify");
  await assert.rejects(fileDissent(store, concern(), { by: "other" }), /only the contract's orchestrator/);
  await assert.rejects(fileDissent(store, concern({ tripwire: { kind: "check_failed", check: "missing" } }), { by: "main" }), /unknown command/);
  const invalid = await handleToolCall("file_dissent", { ...args, dissent: concern({ claim: "x".repeat(501) }) });
  assert.equal(invalid.isError, true);
  assert.equal((await contractRecord(store)).version, 3, "invalid filings produce no version");
  provider(t, () => "Consent: AGREE");
  await requestConsent(store, r.contractId, { by: "main", llm });
  await freezeContract(r.contractId, { orchestrator: "main" });
  await assert.rejects(fileDissent(store, concern(), { by: "main" }), /only be filed while the contract is a draft/);
  await assert.rejects(amendContract(store, { dissents: [concern({ on_fire: "huddle" })] }, { by: "main" }), /touches every participant/);
});

test("file_dissent binds agent identity on both servers and forbids impersonation and agent excusal", async () => {
  const { bindWorkerIdentity, resetWorkerTools } = await import("../../dist/tools/worker.js");
  const { tokenSha256 } = await import("../../dist/workers/files.js");
  const r = await propose();
  const store = await openContractStore(r.contractId);
  const auth = await draftAgent(store);
  const args = { contract_id: r.contractId, ...auth, dissent: concern({ by: undefined }) };
  let result = await handleToolCall("file_dissent", args);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal((await contractRecord(store)).contract.dissents[0].by, skeptic);
  for (const bad of [
    { dissent: concern({ by: cfo }) }, { agent_token: "cd".repeat(32) }, { orchestrator: "main" },
    { dissent: { id: concern().id }, excuse_reason: "ignore it" },
  ]) {
    result = await handleToolCall("file_dissent", { ...args, ...bad });
    assert.equal(result.isError, true, result.content[0].text);
  }
  const other = await propose();
  result = await handleToolCall("file_dissent", { ...args, contract_id: other.contractId });
  assert.equal(result.isError, true, "a token cannot select a contract outside its execution");
  bindWorkerIdentity({ store, execution: store.id, agent: skeptic, tokenSha256: tokenSha256(auth.agent_token) });
  try {
    result = await handleToolCall("file_dissent", { contract_id: r.contractId, dissent: concern({ by: undefined, claim: "Revised concern" }) }, "worker");
    assert.equal(result.isError, undefined, result.content[0].text);
    const latest = await contractRecord(store);
    assert.equal(latest.contract.dissents[0].by, skeptic);
    assert.equal((await store.events()).at(-1).source.id, skeptic);
    result = await handleToolCall("file_dissent", { contract_id: r.contractId, dissent: concern({ by: cfo }) }, "worker");
    assert.equal(result.isError, true);
  } finally { resetWorkerTools(); }
});

test("how: dissented retains a concern, consents on its new version, and requires everyone else to re-consent", async (t) => {
  provider(t, answers({ cfo: ["Consent: AGREE", "Consent: AGREE"], skeptic: ["Consent: OBJECT\nEmpty states fail."] }));
  const r = await propose({ consent: true });
  const store = await openContractStore(r.contractId);
  const auth = await draftAgent(store);
  const result = await handleToolCall("file_dissent", { contract_id: r.contractId, ...auth,
    dissent: concern({ by: undefined, tripwire: undefined }), resolve_objection: true });
  assert.equal(result.isError, undefined, result.content[0].text);
  let rec = await contractRecord(store);
  assert.deepEqual(summarizeConsent(rec).agree, [skeptic]);
  assert.deepEqual(summarizeConsent(rec).stale.map((s) => s.agent), [cfo]);
  assert.equal(rec.contract.dissents[0].source.kind, "consent");
  assert.equal(rec.verdicts[skeptic].resolved.how, "dissented");
  assert.equal(rec.verdicts[skeptic].resolved.version, 2);
  const event = (await store.events()).at(-1);
  assert.equal(event.type, "contract.objection_resolved");
  assert.equal(event.payload.how, "dissented");
  assert.equal(event.payload.dissent_id, concern().id);
  await requestConsent(store, r.contractId, { by: "main", participants: [cfo], llm });
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /dissent empty-state-risk needs a tripwire/);
  // Any further edit invalidates even the objector's consent to v2.
  await fileDissent(store, concern(), { by: "main" });
  rec = await contractRecord(store);
  assert.deepEqual(summarizeConsent(rec).stale.map((s) => s.agent), [cfo, skeptic]);
  await assert.rejects(fileDissent(store, concern(), { by: skeptic, source: { kind: "agent", id: skeptic, pid: process.pid }, resolveObjection: true }), /current version/);
});

test("how: dissented needs a current OBJECT and cannot be used by an orchestrator for someone else", async (t) => {
  provider(t, answers({ cfo: ["Consent: AGREE"], skeptic: ["Unclear", "Still unclear"] }));
  const r = await propose({ consent: true });
  const store = await openContractStore(r.contractId);
  await assert.rejects(fileDissent(store, concern(), { by: "main", resolveObjection: true }), /objector's own unresolved OBJECT/);
  await assert.rejects(fileDissent(store, concern(), { by: skeptic, source: { kind: "agent", id: skeptic, pid: process.pid }, resolveObjection: true }), /objector's own unresolved OBJECT/);
  assert.equal((await contractRecord(store)).version, 1);
  const { validateDraft } = await import("../../dist/execution/events.js");
  assert.throws(() => validateDraft({ type: "contract.objection_resolved", source: { kind: "agent", id: skeptic, pid: process.pid },
    payload: { contract: r.contractId, agent: skeptic, how: "dissented", reason: "Proceed" } }), /dissent_id.*required/);
});

test("an armed dissented resolution freezes as AGREE and replay ignores a stale resolution", async (t) => {
  provider(t, answers({ cfo: ["Consent: AGREE", "Consent: AGREE"], skeptic: ["Consent: OBJECT\nEmpty states fail."] }));
  const r = await propose({ consent: true });
  const store = await openContractStore(r.contractId);
  const source = { kind: "agent", id: skeptic, pid: process.pid };
  await fileDissent(store, concern(), { by: skeptic, source, resolveObjection: true });
  const event = (await store.events()).at(-1);
  await store.transact(() => ({ events: [{ ...event, contract_version: 1, payload: { ...event.payload, dissent_id: "missing" } }].map(({ type, source, contract, contract_version, payload }) => ({ type, source, contract, contract_version, payload })) }));
  let rec = await contractRecord(store);
  assert.equal(rec.ignored, 1);
  assert.deepEqual(summarizeConsent(rec).agree, [skeptic]);
  await requestConsent(store, r.contractId, { by: "main", participants: [cfo], llm });
  const f = await freezeContract(r.contractId, { orchestrator: "main" });
  assert.equal(f.contract.consent.find((v) => v.agent === skeptic).verdict, "AGREE");
  assert.equal(f.contract.dissents.length, 1);
  rec = await contractRecord(store);
  assert.equal(summarizeConsent(rec).ready, true);
  assert.equal(contractHash(f.contract), f.hash);
});

test("dissent filing refuses an in-flight consent round without changing its version", async () => {
  const r = await propose();
  const store = await openContractStore(r.contractId);
  await store.transact(() => ({ events: [{ type: "contract.consent_requested", source: { kind: "orchestrator", id: "main", pid: process.pid },
    payload: { contract: r.contractId, version: 1, participants: [skeptic] } }] }));
  await assert.rejects(fileDissent(store, concern(), { by: "main" }), /consent round is in flight/);
  assert.equal((await contractRecord(store)).version, 1);
});

test("amending a historical frozen contract treats absent and empty dissents as the same content", async () => {
  const { makeRun } = await import("../fixtures/workers/run.mjs");
  const run = await makeRun({ contract: {
    tasks: [{ ...baseTasks()[0], kind: "build", depends_on: [], checks: [] }], participants: [{ agent: cfo }], teams: [], decisions: [],
    authority: { lead: cfo, may: ["retry"], budget_extension_pct: 0 },
    sandbox: { backend: "docker", image: "node:lts" },
  } });
  assert.equal(Object.hasOwn(run.contract, "dissents"), false);
  const amended = await amendContract(run.store, { title: "Updated legacy title" }, { by: "main", contractId: run.contract.id });
  assert.equal(amended.version, 2);
  assert.deepEqual(amended.contract.dissents, []);
  const normalized = { ...run.contract, dissents: [] };
  assert.deepEqual(authorityNeeds(run.contract, normalized, []), [], "empty defaults do not require new authority");
});

test("amending away a fired dissent withdraws its escalation, releases its own hold, and audits removal", async (t) => {
  provider(t, () => "Consent: AGREE\nfine");
  const r = await propose({ consent: true, contract: explicit({ dissents: [concern({ by: cfo, on_fire: "pause_and_huddle" })] }) });
  await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  const source = { kind: "runner", id: "runner", pid: process.pid };
  const append = (type, payload) => store.transact(() => ({ events: [{ type, payload, source }] }));
  await append("task.blocked", { task: "ui", deps: ["api"] });
  await append("check.failed", { task: "ui", scope: "task", command_id: "test", exit: 1, signature: "empty state" });
  const { dissentTripwireRules, actionsToDrafts } = await import("../../dist/execution/watchdog.js");
  await store.transact(({ state }) => ({ events: actionsToDrafts(dissentTripwireRules(state)) }));
  const id = Object.values((await store.state()).escalations).find((e) => e.dissent_id)?.id;
  assert.ok(id);
  await amendContract(store, { dissents: [] }, { by: "main", reason: "Removed the risky path", overrideConsent: true });
  const state = await store.state();
  assert.deepEqual(state.dissents, {});
  assert.equal(state.escalations[id].status, "withdrawn");
  assert.deepEqual(state.tasks.ui.blocked_by, { deps: ["api"] });
  assert.equal(state.tasks.ui.state, "blocked");
  assert.ok((await store.events()).some((e) => e.type === "escalation.withdrawn" && e.payload.id === id && /removed by amendment/.test(e.payload.reason)));
  assert.ok((await store.events()).some((e) => e.type === "task.unblocked" && e.payload.escalation === id));
  assert.ok(auditEntries().some((e) => e.action === "contract.amended" && e.target === r.contractId && e.details.removed_dissents?.includes("empty-state-risk")));
});

test("removing an unscoped dissent after an earlier amendment cancelled its affected task still withdraws the escalation", async (t) => {
  provider(t, () => "Consent: AGREE\nfine");
  const d = concern({ by: cfo, tripwire: { kind: "check_failed", check: "test" }, on_fire: "pause_and_huddle" });
  const r = await propose({ consent: true, contract: explicit({ dissents: [d] }) });
  await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  const source = { kind: "runner", id: "runner", pid: process.pid };
  await store.transact(() => ({ events: [{ type: "check.failed", source, payload: { task: "ui", scope: "task", command_id: "test", exit: 1, signature: "empty state" } }] }));
  const { dissentTripwireRules, actionsToDrafts } = await import("../../dist/execution/watchdog.js");
  await store.transact(({ state }) => ({ events: actionsToDrafts(dissentTripwireRules(state)) }));
  const id = Object.values((await store.state()).escalations).find((e) => e.dissent_id)?.id;
  assert.ok(id);
  await amendContract(store, { tasks: [baseTasks()[0]], interfaces: [{ ...explicit().interfaces[0], consumers: [] }] },
    { by: "main", reason: "Remove the UI task", overrideConsent: true });
  let state = await store.state();
  assert.equal(state.tasks.ui.state, "cancelled");
  assert.equal(state.escalations[id].status, "open");
  assert.ok(state.dissents[d.id]);
  const sinceSeq = state.seq;
  await amendContract(store, { dissents: [] }, { by: "main", reason: "Remove the obsolete concern", overrideConsent: true });
  state = await store.state();
  assert.equal(state.tasks.ui.state, "cancelled");
  assert.equal(state.escalations[id].status, "withdrawn");
  assert.deepEqual(state.dissents, {});
  const events = await store.events({ sinceSeq });
  assert.ok(events.some((e) => e.type === "escalation.withdrawn" && e.payload.id === id));
  assert.ok(!events.some((e) => e.type === "task.unblocked" && e.payload.task === "ui"));
  assert.ok(auditEntries().some((e) => e.action === "contract.amended" && e.target === r.contractId && e.details.removed_dissents?.includes(d.id)));
  const { openExecutionStore } = await import("../../dist/execution/store.js");
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
});

test("withdrawing dissents releases their dependent-task human pauses after cancellation, preserving manual and other-escalation pauses", async (t) => {
  provider(t, () => "Consent: AGREE");
  const dependents = ["followup", "manual", "other"].map((id) => ({ ...baseTasks()[1], id, depends_on: ["ui"], paths: { write: [`src/${id}/**`] } }));
  const dissents = ["first-risk", "second-risk"].map((id) => concern({ id, by: cfo, tripwire: { kind: "check_failed", check: "test" }, on_fire: "pause_and_huddle" }));
  const r = await propose({ consent: true, contract: explicit({ tasks: [...baseTasks(), ...dependents], dissents }) });
  await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  const source = { kind: "runner", id: "runner", pid: process.pid };
  const emit = (events) => store.transact(() => ({ events: events.map((e) => ({ source, ...e })) }));
  await emit([{ type: "check.failed", payload: { task: "ui", scope: "task", command_id: "test", exit: 1, signature: "empty state" } }]);
  const { dissentTripwireRules, actionsToDrafts } = await import("../../dist/execution/watchdog.js");
  const { awaitHuman, resolveEscalation } = await import("../../dist/execution/escalation.js");
  await store.transact(({ state }) => ({ events: actionsToDrafts(dissentTripwireRules(state)) }));
  const ids = Object.values((await store.state()).escalations).filter((e) => e.dissent_id).map((e) => e.id);
  assert.equal(ids.length, 2);
  const ctx = { store, state: await store.state(), llm };
  for (const id of ids) await awaitHuman(ctx, id, { actor: { kind: "runner" } });
  await emit([
    { type: "execution.paused", payload: { scope: ["manual"], reason: "Manual inspection" } },
    { type: "escalation.raised", payload: { escalation: { id: "other-emergency", agent: cfo, task: "other", kind: "emergency", with: "orchestrator", summary: "Separate human action", blocking: false, status: "open", raised_seq: 0 } } },
  ]);
  await awaitHuman(ctx, "other-emergency", { actor: { kind: "runner" } });
  assert.deepEqual((await store.state()).paused_tasks.sort(), ["followup", "manual", "other", "ui"]);
  await amendContract(store, { tasks: [baseTasks()[0], ...dependents.map((task) => ({ ...task, depends_on: [] }))], interfaces: [{ ...explicit().interfaces[0], consumers: [] }] },
    { by: "main", reason: "Cancel UI and make followups independent", overrideConsent: true });
  assert.equal((await store.state()).tasks.ui.state, "cancelled");
  const sinceSeq = (await store.state()).seq;
  await amendContract(store, { dissents: [] }, { by: "main", reason: "Withdraw obsolete concerns", overrideConsent: true });
  let state = await store.state();
  assert.equal(state.tasks.ui.state, "cancelled");
  assert.equal(state.tasks.followup.state, "ready");
  assert.deepEqual(state.paused_tasks.sort(), ["manual", "other"]);
  for (const id of ids) assert.equal(state.escalations[id].status, "withdrawn");
  const resumes = (await store.events({ sinceSeq, types: ["execution.resumed"] }));
  assert.ok(resumes.some((e) => ids.includes(e.correlation) && e.payload.scope.includes("followup")));
  assert.ok(resumes.every((e) => !e.payload.scope.includes("manual") && !e.payload.scope.includes("other")));
  await resolveEscalation(ctx, "other-emergency", { action: "decide", decision: "Continue", resolved_by: "main" });
  state = await store.state();
  assert.deepEqual(state.paused_tasks, ["manual"]);
  const { openExecutionStore } = await import("../../dist/execution/store.js");
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
});

test("incomplete dissents block freeze despite consent excusals; explicit dissent excusal preserves history and requires re-consent", async (t) => {
  provider(t, () => "Consent: AGREE");
  const r = await propose({ contract: explicit({ dissents: [concern({ tripwire: undefined })] }) });
  const store = await openContractStore(r.contractId);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main", excuse: [cfo, skeptic].map((agent) => ({ agent, reason: "proceed" })) }), /dissent empty-state-risk needs a tripwire/);
  await requestConsent(store, r.contractId, { by: "main", llm });
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /dissent empty-state-risk needs a tripwire/);
  await assert.rejects(fileDissent(store, { id: concern().id }, { by: "main", excuseReason: " " }), /must be non-empty/);
  const result = await handleToolCall("file_dissent", { contract_id: r.contractId, orchestrator: "main", dissent: { id: concern().id }, excuse_reason: "The goal no longer includes empty states." });
  assert.equal(result.isError, undefined, result.content[0].text);
  let rec = await contractRecord(store);
  assert.deepEqual(rec.contract.dissents, []);
  assert.equal(rec.version, 2);
  assert.equal(summarizeConsent(rec).ready, false);
  const prior = JSON.parse((await store.getBlob(rec.versions[0].blob)).toString());
  assert.equal(prior.dissents[0].claim, concern().claim);
  assert.match((await store.events()).at(-1).payload.reason, /Excused dissent empty-state-risk: The goal/);
  assert.ok(auditEntries().some((e) => e.action === "contract.dissent_excused" && e.target === r.contractId));
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /not on v2/);
  await requestConsent(store, r.contractId, { by: "main", llm });
  const frozen = await freezeContract(r.contractId, { orchestrator: "main" });
  assert.deepEqual(frozen.contract.dissents, []);
  rec = await contractRecord(store);
  assert.equal(summarizeConsent(rec).ready, true);
});

test("unsigned ultraplan OBJECT sign-offs import as drafts with provenance; UNCLEAR and approved sign-offs do not", async (t) => {
  provider(t, () => "Consent: AGREE");
  for (const signedOff of [false, true]) {
    const id = signedOff ? "ultraplan-approved1" : "ultraplan-dissents1";
    const plan = blockText({ tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] });
    archiveSession({ id, kind: "ultraplan", agents: [cfo, skeptic, ops], topic: "Ship orders", started: new Date().toISOString(), turns: [],
      document: { markdown: plan, signedOff, version: 1, planner: "orchestrator",
        versions: [{ version: 1, plan, author: "orchestrator", at: "t" }], entries: [],
        signoffs: [{ agent: skeptic, verdict: "OBJECT", content: "Empty states will fail." },
          { agent: ops, verdict: "UNCLEAR", content: "Not sure." }, { agent: cfo, verdict: "APPROVE", content: "Looks good." }], tally: {} }, public: null });
    const r = await propose({ fromSession: id, contract: undefined, originalPrompt: undefined });
    assert.equal(r.contract.dissents.length, signedOff ? 0 : 1);
    if (signedOff) continue;
    const d = r.contract.dissents[0];
    assert.equal(d.by, skeptic);
    assert.deepEqual(d.source, { kind: "ultraplan", ref: id });
    assert.equal(d.claim, "Empty states will fail.");
    assert.equal(d.tripwire, undefined);
    const store = await openContractStore(r.contractId);
    await requestConsent(store, r.contractId, { by: "main", llm });
    await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /dissent ultraplan-object-1 needs a tripwire/);
    await fileDissent(store, { ...d, tripwire: { kind: "path_touched", paths: ["src/ui/**"], task: "ui" } }, { by: "main" });
    await requestConsent(store, r.contractId, { by: "main", llm });
    const frozen = await freezeContract(r.contractId, { orchestrator: "main" });
    assert.equal(frozen.contract.dissents[0].tripwire.kind, "path_touched");
  }
});

const dissentBlock = (claim = "Empty states fail.", prediction = "The page check fails with no orders.") =>
  `<DISSENT>\nclaim: ${claim}\npredicted_failure: ${prediction}\n</DISSENT>`;

test("a completed adversarial session imports its actual closing dissent through propose_contract", async (t) => {
  const { startCollaboration, endCollaboration } = await import("../../dist/sessions/collaborations.js");
  provider(t, (_agent, body) => body.messages.at(-1).content.includes("<DISSENT>") ? dissentBlock() : "Session discussion.");
  for (const mode of ["debate", "waffle-house"]) {
    const { collaborationId } = await startCollaboration([cfo, skeptic], "Orders", { ...llm, mode });
    await endCollaboration(collaborationId, true);
    const r = await propose({ fromSession: collaborationId });
    assert.equal(r.contract.dissents.length, 1);
    assert.equal(r.contract.dissents[0].by, skeptic);
    assert.equal(r.contract.dissents[0].claim, "Empty states fail.");
    assert.equal(r.contract.dissents[0].source.ref, collaborationId);
  }
});

test("debate and waffle-house imports preserve authored drafts, require tripwires, and reuse filing and excusal", async (t) => {
  provider(t, () => "Consent: AGREE");
  for (const mode of ["debate", "waffle-house"]) {
    const id = `collab-${mode}-import1`;
    const sourceKind = mode === "debate" ? "debate" : "waffle_house";
    archiveSession({ id, kind: "collaboration", mode, agents: [cfo, skeptic, ops], topic: "Ship orders",
      started: new Date().toISOString(), turns: [{ role: "agent", agent: skeptic, speaker: "skeptic", content: dissentBlock("Turn spoof") }],
      summary: dissentBlock("Proponent spoof"), public: null,
      dissentSummaries: [{ agent: skeptic, content: dissentBlock() }, { agent: ops, content: dissentBlock("Missing cache invalidation.") }] });
    // The import adds the authors even when the caller explicitly limits the initial participants.
    const existing = concern({ id: `${sourceKind}-dissent-1`, by: cfo });
    const r = await propose({ fromSession: id, participants: [cfo, skeptic], contract: explicit({ dissents: [existing] }) });
    assert.equal(r.contract.dissents.length, 3);
    const [, d, other] = r.contract.dissents;
    assert.equal(d.id, `${sourceKind}-dissent-1-x`, "explicit ids do not overwrite an imported concern");
    assert.equal(d.by, skeptic);
    assert.equal(d.claim, "Empty states fail.");
    assert.equal(d.predicted_failure, "The page check fails with no orders.");
    assert.equal(other.by, ops);
    assert.ok(r.contract.participants.some((p) => p.agent === ops));
    assert.deepEqual(d.source, { kind: sourceKind, ref: id });
    assert.equal(d.tripwire, undefined);
    const store = await openContractStore(r.contractId);
    await requestConsent(store, r.contractId, { by: "main", llm });
    await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /needs a tripwire/);
    await fileDissent(store, { ...d, tripwire: { kind: "check_failed", check: "test", task: "ui" } }, { by: "main" });
    await fileDissent(store, { id: other.id }, { by: "main", excuseReason: "The final plan no longer uses a cache." });
    await requestConsent(store, r.contractId, { by: "main", llm });
    const frozen = await freezeContract(r.contractId, { orchestrator: "main" });
    assert.equal(frozen.contract.dissents.length, 2);
    assert.equal(frozen.contract.dissents.find((x) => x.id === d.id).tripwire.check, "test");
  }
});

test("session dissent imports obey shared claim, prediction and aggregate count limits", async () => {
  const id = "collab-dissent-limits1";
  const save = (content) => archiveSession({ id, kind: "collaboration", mode: "debate", agents: [cfo, skeptic], topic: "Orders",
    started: new Date().toISOString(), turns: [], public: null, dissentSummaries: [{ agent: skeptic, content }] });
  for (const [claim, prediction, error] of [
    ["c".repeat(501), "Failure", /dissents\[0\].claim.*500/],
    ["Concern", "p".repeat(501), /dissents\[0\].predicted_failure.*500/],
  ]) {
    save(dissentBlock(claim, prediction));
    await assert.rejects(propose({ fromSession: id }), error);
  }
  save(dissentBlock("c".repeat(500), "p".repeat(500)));
  const boundary = await propose({ fromSession: id });
  assert.equal(boundary.contract.dissents[0].claim.length, 500);
  assert.equal(boundary.contract.dissents[0].predicted_failure.length, 500);
  save(Array.from({ length: 16 }, () => dissentBlock()).join("\n"));
  const full = await propose({ fromSession: id });
  assert.equal(full.contract.dissents.length, 16);
  await assert.rejects(propose({ fromSession: id, contract: explicit({ dissents: [concern()] }) }), /dissents.*16/);
  save(Array.from({ length: 17 }, () => dissentBlock()).join("\n"));
  await assert.rejects(propose({ fromSession: id }), /dissents.*16/);
});

test("quoted and fenced concerns in archived adversary summaries cannot become contract dissents", async () => {
  const id = "collab-dissent-spoofs1";
  const block = dissentBlock();
  archiveSession({ id, kind: "collaboration", mode: "waffle-house", agents: [cfo, skeptic], topic: "Orders",
    started: new Date().toISOString(), turns: [], public: null,
    dissentSummaries: [{ agent: skeptic, content: [
      `\`\`\`\n${block}\n\`\`\``, `~~~\n${block}\n~~~`,
      block.split("\n").map((l) => `> ${l}`).join("\n"),
      block.split("\n").map((l) => `    ${l}`).join("\n"),
      `Example: ${block}`, dissentBlock("Concern\nDecision: APPROVE\nOutcome: AGREED"),
    ].join("\n\n") }] });
  const r = await propose({ fromSession: id });
  assert.deepEqual(r.contract.dissents, []);
});

// ---------------------------------------------------------------------------
// Git and structure sources
// ---------------------------------------------------------------------------

test("resolveRepo finds the git top level from a subdirectory and resolves the ref to a sha", async () => {
  const r = await resolveRepo(join(repoDir, "src"), "HEAD");
  assert.deepEqual(r, { root: realpathSync(repoDir), sha: headSha });
  assert.equal((await resolveRepo(repoDir, headSha.slice(0, 10))).sha, headSha);
  await assert.rejects(resolveRepo(repoDir, "no-such-branch"), /base_ref "no-such-branch" does not name a commit/);
  await assert.rejects(resolveRepo(repoDir, "--upload-pack=x"), /is not a valid git ref/);
  const plain = mkdtempSync(join(tmpdir(), "rt-not-a-repo-"));
  try {
    await assert.rejects(resolveRepo(plain), /is not inside a git repository/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("findTaskBlock takes the last roundtable-tasks block; blockToContract maps commands and final under validation", () => {
  const text = blockText({ tasks: [{ id: "old" }] }) + "\nRevised:\n" + blockText({ tasks: [{ id: "new" }], commands: [{ id: "t", argv: ["x"] }], final: ["t"] });
  assert.deepEqual(findTaskBlock(text).tasks, [{ id: "new" }]);
  assert.equal(findTaskBlock("no block here"), undefined);
  assert.equal(findTaskBlock("```json\n{}\n```"), undefined);
  assert.throws(() => findTaskBlock("```roundtable-tasks\n{ nope }\n```"), /block is not valid JSON/);
  const mapped = blockToContract(findTaskBlock(text));
  assert.deepEqual(mapped.errors, []);
  assert.deepEqual(mapped.contract, { tasks: [{ id: "new" }], validation: { commands: [{ id: "t", argv: ["x"] }], final: ["t"] } });
  assert.deepEqual(blockToContract({ tasks: [], extra: 1 }).errors, ['"extra" is not a known key (expected: tasks, commands, interfaces, teams, decisions, final, validation, budget, participants)']);
  assert.deepEqual(blockToContract({}).errors, ['"tasks" is required']);
  assert.deepEqual(blockToContract([1]).errors, ["the roundtable-tasks JSON must be an object"]);
});

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

test("propose with an explicit contract creates the store, header, events and files", async () => {
  const before = (await listExecutions()).length;
  const r = await propose();
  assert.equal((await listExecutions()).length, before + 1);
  assert.match(r.contractId, /^ctr-[0-9a-hjkmnp-tv-z]{6}-1$/);
  assert.equal(r.contractId.slice(4, 10), r.executionId.slice(-6), "the contract id carries the execution tag");
  assert.equal(r.source, "explicit");
  assert.equal(r.status, "draft");
  assert.equal(r.version, 1);
  const store = await openContractStore(r.contractId);
  assert.equal(store.id, r.executionId);
  const header = store.header();
  assert.equal(header.base_sha, headSha);
  assert.equal(header.repo_root, realpathSync(repoDir));
  const events = await store.events();
  assert.deepEqual(events.map((e) => e.type), ["execution.created", "contract.proposed"]);
  assert.deepEqual(events[0].payload, { repo_root: realpathSync(repoDir), base_sha: headSha, contract: r.contractId, contract_version: 1 });
  assert.deepEqual(events.map((e) => [e.mode, e.source.kind, e.source.id, e.contract, e.contract_version]), [
    ["deliberation", "orchestrator", "main", r.contractId, 1], ["deliberation", "orchestrator", "main", r.contractId, 1],
  ]);
  assert.equal(events[1].payload.source, "explicit");
  const stored = JSON.parse((await store.getBlob(events[1].payload.blob)).toString("utf8"));
  assert.equal(stored.id, r.contractId);
  assert.equal(stored.goal.original_prompt, "please ship the orders page");
  assert.equal(stored.scope.base_ref, headSha);
  assert.deepEqual(stored.participants.map((p) => p.agent), [cfo, skeptic]);
  assert.equal((await store.state()).contract, undefined, "a proposal does not reach the blackboard");
  for (const path of [r.paths.json, r.paths.markdown]) {
    assert.ok(path.startsWith(join(store.dir, "contracts", r.contractId)), path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.ok(r.paths.json.endsWith("v1.json"));
  assert.match(readFileSync(r.paths.markdown, "utf8"), /^# Contract: Ship the orders page/);
  assert.deepEqual(r.consent.missing, [cfo, skeptic]);
  assert.match(r.next, /Nobody has consented to v1 yet from/);
  assert.deepEqual(await store.verify(), { ok: true, seq: 2 });
  assert.equal(git("status", "--porcelain"), "", "nothing is written to the repository");
});

test("explicit id, status and consent are set by propose; an invalid contract creates no store", async () => {
  const r = await propose({ contract: explicit({ id: "ctr-zzzzzz-9", status: "frozen", consent: [{ agent: cfo, verdict: "AGREE" }] }) });
  assert.notEqual(r.contractId, "ctr-zzzzzz-9");
  assert.equal(r.status, "draft");
  assert.ok(r.warnings.some((w) => /contract\.id is set by propose_contract/.test(w)));
  assert.deepEqual(r.contract.consent, []);
  const before = (await listExecutions()).length;
  await assert.rejects(propose({ contract: explicit({ tasks: [{ ...baseTasks()[0], depends_on: ["ghost"] }] }) }), /The contract is not valid:\n- tasks\[0\]\.depends_on names unknown task "ghost"/);
  await assert.rejects(propose({ originalPrompt: undefined }), /original_prompt is required/);
  await assert.rejects(propose({ repoDir: tmpdir() }), /is not inside a git repository/);
  await assert.rejects(propose({ contract: undefined }), /needs a structure/);
  assert.equal((await listExecutions()).length, before);
});

test("propose takes a fenced block from the plan, with an explicit contract overlaying it", async () => {
  const structure = { tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] };
  const r = await propose({ contract: { budget: { usd: 7, per_task_usd: 2 } }, plan: blockText(structure) });
  assert.equal(r.source, "fenced:plan");
  assert.deepEqual(r.contract.tasks.map((t) => t.id), ["api", "ui"]);
  assert.equal(r.contract.budget.usd, 7);
  assert.deepEqual(r.contract.validation.final, ["test"]);
  await assert.rejects(propose({ contract: undefined, plan: blockText({ tasks: baseTasks(), extra: true }) }), /block in plan is not usable:\n- "extra" is not a known key/);
});

test("propose builds from an archived ultraplan: its block, its task as the original prompt, its agents as participants", async () => {
  const id = "ultraplan-orders01";
  const plan = "1. Build the API [cfo]\n2. Build the page [skeptic]\n\n" + blockText({ tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] });
  archiveSession({
    id, kind: "ultraplan", mode: "orchestrator", agents: [cfo, skeptic, ops], topic: "Plan the orders page", started: new Date().toISOString(),
    turns: [{ role: "orchestrator", speaker: "orchestrator · plan v1", phase: "plan v1", content: plan }],
    document: { markdown: `# Ultraplan: Plan the orders page\n\n${plan}`, signedOff: true, version: 1, planner: "orchestrator",
      versions: [{ version: 1, plan, author: "orchestrator", at: new Date().toISOString() }], entries: [], signoffs: [], tally: {} },
    public: null,
  });
  const src = sessionSource((await import("../../dist/sessions/archive.js")).readArchivedSession(id));
  assert.equal(src.planText, plan);
  const r = await propose({ contract: undefined, originalPrompt: undefined, fromSession: id });
  assert.equal(r.source, `fenced:${id}`);
  assert.equal(r.contract.goal.original_prompt, "Plan the orders page");
  assert.equal(r.contract.goal.source_session, id);
  assert.deepEqual(r.contract.participants.map((p) => p.agent), [cfo, skeptic, ops]);
  await assert.rejects(propose({ fromSession: "ultraplan-missing0" }), /from_session not found in the archive/);
});

test("structuring: an invalid first answer is retried once with its errors; the second is used", async (t) => {
  const bad = { tasks: [{ ...baseTasks()[0], checks: ["lint"] }], commands: [{ id: "test", argv: ["npm", "test"] }] };
  const good = { tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] };
  const calls = provider(t, (agent, body, i) => (i === 0 ? JSON.stringify(bad) : "Here it is:\n" + JSON.stringify(good)));
  const r = await propose({ contract: undefined, plan: "Build an API, then a page that lists orders." });
  assert.equal(r.source, "structured:plan");
  assert.equal(calls.length, 2);
  const first = calls[0].body.messages;
  assert.match(first[0].content, /neutral contract architect/);
  assert.ok(first[1].content.includes("**Plan:**\nBuild an API, then a page that lists orders."));
  assert.ok(first[1].content.includes('"paths": { "write"'));
  const retry = calls[1].body.messages;
  assert.equal(retry.length, 4);
  assert.equal(retry[2].role, "assistant");
  assert.match(retry[3].content, /^Your output was not usable: .*tasks\[0\]\.checks\[0\] names unknown command "lint".*Return only the corrected JSON object\.$/s);
  assert.deepEqual(r.contract.tasks.map((x) => x.id), ["api", "ui"]);
});

test("structuring fails after two unusable answers and creates no store", async (t) => {
  const calls = provider(t, (agent, body, i) => (i === 0 ? "No JSON at all" : JSON.stringify({ tasks: [] })));
  const before = (await listExecutions()).length;
  await assert.rejects(propose({ contract: undefined, plan: "Some plan" }),
    /The structuring call did not return a usable contract after one retry: tasks must list at least one task/);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[3].content, /No JSON object found/);
  assert.equal((await listExecutions()).length, before);
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test("consent: AGREE, OBJECT, and UNCLEAR re-asked once with a stricter prompt and then counted as an objection", async (t) => {
  const calls = provider(t, answers({
    cfo: ["Consent: AGREE\nThe API scope is right."],
    skeptic: ["I am not sure yet.", "Consent: OBJECT\nThe page needs empty-state tests."],
    ops: ["Maybe.", "Still thinking."],
  }));
  const r = await propose({ consent: true, participants: [cfo, skeptic, ops] });
  assert.deepEqual(r.asked, [cfo, skeptic, ops]);
  assert.equal(calls.length, 5, "one call each, plus one re-ask for each unclear answer");
  assert.deepEqual(r.consent.agree, [cfo]);
  assert.deepEqual(r.consent.objections.map((o) => [o.agent, o.verdict]), [[skeptic, "OBJECT"], [ops, "UNCLEAR"]]);
  assert.equal(r.consent.objections[0].reason, "The page needs empty-state tests.");
  assert.match(r.consent.objections[1].reason, /even after a stricter re-ask \(counted as an objection\)/);
  assert.equal(r.consent.ready, false);
  const reasks = calls.filter((c) => c.body.messages.length === 4);
  assert.equal(reasks.length, 2);
  for (const c of reasks) assert.equal(c.body.messages[3].content, CONSENT_REASK);
  const prompt = calls.find((c) => agentOf(c.body) === "skeptic").body.messages[1].content;
  for (const part of ["Every participant must consent", "Your tasks are marked (yours): ui", "### 2. `ui` — Orders page (yours)", "## Interfaces", "**OrdersApi**",
    "## Decisions", "REST, not GraphQL", "## Validation", "## Budget and authority", "$10 total", "**Original request:**", "please ship the orders page",
    "Answer `Consent: AGREE` or `Consent: OBJECT` on the first line, then your reason."]) {
    assert.ok(prompt.includes(part), `consent prompt lacks ${JSON.stringify(part)}`);
  }
  assert.ok(!prompt.includes("### 1. `api` — Orders API (yours)"));
  assert.match(calls[0].body.messages[0].content, /## Contract consent/);
  const store = await openContractStore(r.contractId);
  const types = (await store.events()).map((e) => [e.type, e.batch?.n ?? 1]);
  assert.deepEqual(types.slice(2), [["contract.consent_requested", 1], ["contract.consent_recorded", 3], ["contract.consent_recorded", 3], ["contract.consent_recorded", 3]]);
  const requested = (await store.events({ types: ["contract.consent_requested"] }))[0].payload;
  assert.deepEqual([requested.contract, requested.version, requested.participants], [r.contractId, 1, [cfo, skeptic, ops]]);
  assert.match(requested.round, /^rnd-[0-9a-z]{8}$/);
  assert.equal(requested.hash, consentHash((await contractRecord(store)).contract));
  assert.equal(typeof requested.host, "string");
  for (const e of await store.events({ types: ["contract.consent_recorded"] })) assert.equal(e.payload.round, requested.round);
  assert.match(r.next, /Objections to v1: .*Address them with amend_contract/);
});

test("consent reasons drop the verdict line; prompts mark only the participant's own tasks", () => {
  assert.equal(consentReason("**Consent:** OBJECT\nNeeds tests.\nAlso docs."), "Needs tests.\nAlso docs.");
  assert.equal(consentReason("Thinking...\nConsent: AGREE\nFine."), "Thinking...\nFine.");
  assert.equal(consentReason("x".repeat(10_000)).length < 3_100, true);
  const c = checkContract({ id: "ctr-abc123-1", title: "T", goal: { ultimate: "G", original_prompt: "P" }, scope: { orchestrator: "m", repo_root: "/r", base_ref: "h" },
    tasks: [{ id: "a", title: "A", persona: "x" }, { id: "b", title: "B", persona: "y" }] }).contract;
  const prompt = buildConsentPrompt(c, "z");
  assert.ok(prompt.includes("You have no tasks of your own"));
  assert.ok(!prompt.includes("(yours)"));
});

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

async function agreedContract(t, over = {}) {
  provider(t, answers({ cfo: ["Consent: AGREE\nok"], skeptic: ["Consent: AGREE\nok"] }));
  return propose({ consent: true, ...over });
}

test("freeze refuses a caller who is not the contract's orchestrator, and a contract nobody consented to", async () => {
  const r = await propose();
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "someone-else" }), (e) => {
    assert.ok(e instanceof ContractRefusal);
    assert.ok(e.reasons.some((x) => /only the contract's orchestrator \(main\) can freeze it; someone-else cannot/.test(x)));
    assert.ok(e.reasons.some((x) => /has not consented/.test(x)));
    return true;
  });
  await assert.rejects(freezeContract("ctr-zzzzzz-1", { orchestrator: "main" }), /Contract ctr-zzzzzz-1 not found/);
  await assert.rejects(freezeContract("bogus", { orchestrator: "main" }), /Not a contract id/);
});

test("freeze refuses unresolved objections and unclear answers; excusals must name participants with an objection", async (t) => {
  provider(t, answers({ cfo: ["Consent: AGREE\nok"], skeptic: ["Consent: OBJECT\nno tests"] }));
  const r = await propose({ consent: true });
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /skeptic\.md objects: no tests/);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main", excuse: [{ agent: cfo, reason: "x" }] }), /already agreed to v1: there is nothing to excuse/);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main", excuse: [{ agent: "stranger", reason: "x" }] }), /stranger is not a participant/);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main", excuse: [{ agent: skeptic, reason: " " }] }), /needs a reason/);
  assert.equal((await contractRecord(await openContractStore(r.contractId))).status, "draft", "a refusal records nothing");
});

test("freeze refuses while the source session is busy or a consent round is in flight", async (t) => {
  const id = "collab-busy0001";
  archiveSession({ id, kind: "collaboration", agents: [cfo, skeptic], topic: "Orders", started: new Date().toISOString(),
    turns: [{ role: "agent", agent: cfo, speaker: "cfo", content: blockText({ tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] }) }], public: null });
  const r = await agreedContract(t, { contract: undefined, fromSession: id, originalPrompt: "orders please" });
  assert.equal(r.source, `fenced:${id}`);
  const release = lockSession(id, "busy");
  try {
    await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /source session collab-busy0001 is busy/);
  } finally {
    release();
  }
  // A round another process started a moment ago is in flight until it is recorded or goes stale.
  const store = await openContractStore(r.contractId);
  await store.transact(() => ({ events: [{ type: "contract.consent_requested", source: { kind: "orchestrator", id: "main", pid: 1 }, payload: { contract: r.contractId, version: 1, participants: [cfo] } }] }));
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /a consent round is in flight \(1 answers pending\)/);
  const stale = await contractRecord(store, r.contractId, Date.now() + consentRoundStaleMs(1) + 1);
  assert.equal(stale.round.inFlight, false);
  assert.equal(stale.verdicts[cfo].verdict, "UNCLEAR", "an abandoned round's missing answers count as unclear");
});

test("freeze with an excusal: one batch, the hash on the blackboard and in the audit log, the excusal audited", async (t) => {
  provider(t, answers({ cfo: ["Consent: AGREE\nok"], skeptic: ["Consent: OBJECT\nno tests"] }));
  const r = await propose({ consent: true });
  const f = await freezeContract(r.contractId, { orchestrator: "main", excuse: [{ agent: skeptic, reason: "tests come in a follow-up" }] });
  assert.equal(f.status, "frozen");
  assert.match(f.hash, /^[0-9a-f]{64}$/);
  const store = await openContractStore(r.contractId);
  const events = (await store.events()).slice(-2);
  assert.deepEqual(events.map((e) => [e.type, e.batch]), [["contract.objection_resolved", { n: 2, i: 0 }], ["contract.frozen", { n: 2, i: 1 }]]);
  assert.deepEqual(events[0].payload, { contract: r.contractId, agent: skeptic, how: "excused", reason: "tests come in a follow-up" });
  assert.equal(events[1].payload.hash, f.hash);
  const state = await store.state();
  assert.equal(state.contract.status, "frozen");
  assert.equal(state.contract.frozen.hash, f.hash);
  assert.equal(state.contract.frozen.by, "main");
  assert.deepEqual(Object.fromEntries(Object.entries(state.tasks).map(([id, x]) => [id, x.state])), { api: "ready", ui: "pending" });
  const blob = JSON.parse((await store.getBlob(events[1].payload.blob)).toString("utf8"));
  assert.equal(contractHash(blob), f.hash, "the hash is the frozen blob's content hash");
  assert.deepEqual(blob.consent.map((c) => [c.agent, c.verdict]), [[cfo, "AGREE"], [skeptic, "EXCUSED"]]);
  const audit = auditEntries().filter((e) => e.target === r.contractId);
  assert.deepEqual(audit.map((e) => e.action), ["contract.objection_excused", "contract.frozen"]);
  assert.equal(audit[1].details.hash, f.hash);
  assert.equal(audit[1].actor, "main");
  assert.equal(audit[0].details.reason, "tests come in a follow-up");
  assert.ok(JSON.parse(readFileSync(f.paths.json, "utf8")).frozen.hash === f.hash);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /already frozen \(v1 by main\)/);
  assert.match(f.next, /Frozen at v1/);
});

test("a child contract: proposed by the parent task's persona; frozen only once the parent is frozen", async (t) => {
  const subTask = { id: "sub", title: "Sub", persona: cfo, kind: "subcontract", paths: { write: ["src/sub/**"] }, acceptance: ["done"], checks: ["test"], budget_usd: 4 };
  const parent = await propose({ contract: explicit({ tasks: [...baseTasks(), subTask] }) });
  const childContract = { tasks: [{ id: "x", title: "X", persona: cfo, paths: { write: ["src/sub/x/**"] }, acceptance: ["ok"], checks: [] }], budget: { usd: 3, per_task_usd: 1 } };
  await assert.rejects(propose({ orchestrator: "stranger", parentContract: parent.contractId, parentTask: "sub", contract: childContract }), /Only the parent task's persona/);
  provider(t, answers({ cfo: ["Consent: AGREE\nok"] }));
  const child = await propose({ orchestrator: cfo, parentContract: parent.contractId, parentTask: "sub", contract: childContract, consent: true });
  assert.deepEqual(child.contract.scope.parent, { contract: parent.contractId, task: "sub" });
  assert.equal(child.contract.scope.repo_root, parent.contract.scope.repo_root);
  await assert.rejects(freezeContract(child.contractId, { orchestrator: cfo }), new RegExp(`its parent ${parent.contractId} is not frozen`));
  await assert.rejects(propose({ orchestrator: cfo, parentContract: parent.contractId, parentTask: "sub", contract: { ...childContract, budget: { usd: 9, per_task_usd: 1 } } }),
    /budget\.usd \(\$9\) exceeds what the parent task may spend \(\$4/);
});

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

test("amending a draft proposes v2, which every participant must consent to again; an objector who agrees is resolved", async (t) => {
  const three = explicit({ tasks: [...baseTasks(), { id: "docs", title: "Docs", persona: ops, paths: { write: ["docs/**"] }, acceptance: ["written"], checks: [] }],
    scope: { paths: ["src/**", "docs/**"] } });
  const calls = provider(t, answers({
    cfo: ["Consent: AGREE\nok", "Consent: AGREE\nstill fine"], skeptic: ["Consent: AGREE\nok", "Consent: AGREE\nstill fine"],
    ops: ["Consent: OBJECT\ndocs too vague", "Consent: AGREE\nclear now"],
  }));
  const r = await propose({ contract: three, consent: true });
  assert.deepEqual(r.consent.objections.map((o) => o.agent), [ops]);
  const store = await openContractStore(r.contractId);
  const tasks = three.tasks.map((x) => (x.id === "docs" ? { ...x, acceptance: ["a README section per endpoint"] } : x));
  const a = await amendContract(store, { tasks }, { by: "main", reason: "make docs concrete", consent: llm });
  assert.equal(a.version, 2);
  assert.equal(a.status, "draft");
  assert.deepEqual(a.affected.changed, ["docs"]);
  assert.deepEqual(a.asked, [cfo, skeptic, ops], "everyone consented to v1, not to v2");
  assert.equal(consentRequests(calls).length, 6);
  assert.equal(a.consent.ready, true);
  assert.equal(a.consent.version, 2);
  const proposed = (await store.events({ types: ["contract.proposed"] })).at(-1);
  assert.equal(proposed.payload.version, 2);
  assert.equal(proposed.payload.source, "amendment");
  assert.equal(proposed.payload.reason, "make docs concrete");
  const patch = JSON.parse((await store.getBlob(proposed.payload.patch_blob)).toString("utf8"));
  assert.deepEqual(Object.keys(patch), ["tasks"]);
  const resolved = (await store.events({ types: ["contract.objection_resolved"] })).map((e) => e.payload);
  assert.deepEqual(resolved, [{ contract: r.contractId, agent: ops, how: "amended", reason: "agreed to v2" }]);
  assert.equal((await store.state()).contract, undefined, "a draft amendment does not reach the blackboard");
  // The interface consumers of a changed interface are affected too; without consent nobody has agreed to v3.
  const b = await amendContract(store, { interfaces: [{ ...three.interfaces[0], description: "GET /orders?page=" }] }, { by: "main", reason: "paging" });
  assert.deepEqual(b.affected.all, ["api", "ui"]);
  assert.equal(b.consent.ready, false);
  assert.deepEqual(b.consent.stale.map((x) => [x.agent, x.verdict, x.version]), [[cfo, "AGREE", 2], [skeptic, "AGREE", 2], [ops, "AGREE", 2]]);
  assert.match(b.next, /Nobody has consented to v3 yet from: .*cfo\.md \(AGREE on v2\)/);
  await assert.rejects(amendContract(store, {}, { by: "main", reason: "nothing" }), /The patch changes nothing/);
  await assert.rejects(amendContract(store, { id: "x", scope: { repo_root: "/x" }, goal: { original_prompt: "y" } }, { by: "main" }),
    /patch may not change id\n- patch may not change scope\.repo_root\n- patch may not change goal\.original_prompt/);
  await assert.rejects(amendContract(store, { title: "x" }, { by: "intruder" }), /only the contract's orchestrator \(main\) can amend it/);
  await assert.rejects(amendContract(store, { tasks: [{ id: "solo" }] }, { by: "main" }), /The amended contract is not valid/);
});

test("freeze needs AGREE on the current version: an amendment after everyone agreed asks again (the review's repro)", async (t) => {
  const calls = provider(t, () => "Consent: AGREE\nok");
  const r = await propose({ consent: true });
  assert.equal(r.consent.ready, true);
  const store = await openContractStore(r.contractId);
  const wider = baseTasks().map((x) => (x.id === "api" ? { ...x, acceptance: [...x.acceptance, "also rewrite auth"], paths: { write: ["src/**"] } } : x));
  const a = await amendContract(store, { tasks: wider, budget: { usd: 200, per_task_usd: 100 } }, { by: "main", reason: "scope change" });
  assert.equal(a.version, 2);
  assert.equal(a.consent.ready, false);
  assert.doesNotMatch(a.next, /Every participant agreed/);
  assert.match(a.next, /Nobody has consented to v2 yet/);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /answered AGREE on v1, not on v2/);
  const before = calls.length;
  const e = await amendContract(store, {}, { by: "main", reason: "consent", consent: llm });
  assert.deepEqual(e.asked, [cfo, skeptic], "an empty patch asks everyone without an agreement on v2");
  assert.equal(calls.length, before + 2);
  const f = await freezeContract(r.contractId, { orchestrator: "main" });
  assert.equal(f.version, 2);
  const rec = await contractRecord(store);
  assert.deepEqual(Object.values(rec.verdicts).map((v) => `${v.verdict}@v${v.version}`), ["AGREE@v2", "AGREE@v2"]);
});
test("amending a frozen contract: contract.amended v2, removed tasks cancelled, a directive to affected agents, audited", async (t) => {
  const three = explicit({ tasks: [...baseTasks(), { id: "docs", title: "Docs", persona: cfo, paths: { write: ["src/docs/**"] }, acceptance: ["written"], checks: [] }] });
  const r = await agreedContract(t, { contract: three });
  const f = await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  await store.transact(() => ({ events: [{ type: "task.claimed", source: { kind: "runner", id: "runner", pid: 1 }, payload: { task: "ui", agent: "agent-ui", attempt: 1, ttl_s: 0 } }] }));
  const tasks = baseTasks().map((x) => (x.id === "ui" ? { ...x, acceptance: ["renders orders", "has an empty state"] } : x));
  const a = await amendContract(store, { tasks }, { by: "main", reason: "drop docs, add an empty state" });
  assert.equal(a.status, "frozen");
  assert.equal(a.version, 2);
  assert.deepEqual(a.affected.removed, ["docs"]);
  assert.deepEqual(a.affected.changed, ["ui"]);
  const last = (await store.events()).slice(-3);
  assert.deepEqual(last.map((e) => e.type), ["contract.amended", "task.cancelled", "directive.issued"]);
  assert.deepEqual(last[0].payload.affected_tasks, ["docs", "ui"]);
  assert.equal(last[0].payload.reason, "drop docs, add an empty state");
  assert.deepEqual(last[1].payload, { task: "docs", why: "removed by amendment v2: drop docs, add an empty state" });
  assert.deepEqual(last[2].payload.to, ["agent-ui"]);
  assert.match(last[2].payload.text, /^Contract amended to v2: re-read the contract/);
  const state = await store.state();
  assert.equal(state.contract.version, 2);
  assert.equal(state.contract.status, "frozen");
  assert.notEqual(state.contract.frozen.hash, f.hash, "an amended version carries its own hash");
  assert.equal(state.contract.frozen.hash, a.hash);
  assert.equal(state.tasks.docs.state, "cancelled");
  assert.equal(state.tasks.ui.spec.acceptance.length, 2);
  assert.equal(state.inbox["agent-ui"][0].kind, "directive");
  assert.equal(auditEntries().filter((e) => e.target === r.contractId && e.action === "contract.amended")[0].details.hash, a.hash);
  assert.equal((await store.verify()).ok, true);
  // A secret-shaped value in a patch is scrubbed before storage, and the hash is of what is stored.
  const secret = await amendContract(store, { title: "Orders sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }, { by: "main", reason: "rename" });
  const blob = JSON.parse((await store.getBlob((await store.events({ types: ["contract.amended"] })).at(-1).payload.blob)).toString("utf8"));
  assert.doesNotMatch(blob.title, /sk-ant-api03-ABCDEF/);
  assert.equal(contractHash(blob), secret.hash);
});

test("amendContract with an authority: only the lead, only within authority.may, default-deny over every field", async (t) => {
  const may = ["retry", "add_task", "reassign", "extend_budget", "amend_interfaces"];
  const r = await agreedContract(t, { contract: explicit({ authority: { lead: cfo, may, budget_extension_pct: 10 } }) });
  await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  const extra = { id: "tests", title: "Tests", persona: cfo, paths: { write: ["src/tests/**"] }, acceptance: ["covers orders"], checks: ["test"] };
  // Who: the lead only, and never beyond what the contract grants.
  await assert.rejects(amendContract(store, { tasks: [...baseTasks(), extra] }, { by: "intruder", authority: ["add_task"] }), /only the lead \(.*cfo\.md\) amends within the authority; intruder cannot/);
  await assert.rejects(amendContract(store, { tasks: [...baseTasks(), extra] }, { by: cfo, authority: ["add_task", "split_task"] }), /authority\.may \(retry, add_task, reassign, extend_budget, amend_interfaces\) does not grant split_task/);
  await assert.rejects(amendContract(store, { title: "x" }, { by: cfo }), /only the contract's orchestrator \(main\) can amend it without an authority limit/);
  const added = await amendContract(store, { tasks: [...baseTasks(), extra] }, { by: cfo, reason: "goal review: missing tests", authority: ["retry", "add_task"] });
  assert.deepEqual(added.affected.added, ["tests"]);
  const ev = (await store.events({ types: ["contract.amended"] })).at(-1);
  assert.deepEqual([ev.source.kind, ev.source.id], ["agent", cfo]);
  const current = () => contractRecord(store).then((x) => x.contract.tasks);
  const refuse = async (patch, granted, re) => {
    await assert.rejects(amendContract(store, patch, { by: cfo, authority: granted }), (e) => {
      assert.ok(e instanceof AuthorityError, String(e));
      assert.ok(e.needs.some((n) => re.test(n)), JSON.stringify(e.needs));
      return true;
    });
  };
  await refuse({ budget: { usd: 11 } }, ["add_task"], /raising budget\.usd to 11 needs "extend_budget"/);
  await refuse({ budget: { usd: 12 } }, ["extend_budget"], /budget\.usd 12 is beyond the 10% extension limit \(11\)/);
  await refuse({ tasks: [baseTasks()[0], extra], interfaces: [{ ...explicit().interfaces[0], consumers: [] }] }, may, /removing ui is reserved to the orchestrator/);
  await refuse({ tasks: [...baseTasks(), { ...extra, acceptance: ["other"] }] }, may, /changing the spec of tests is reserved/);
  await refuse({ tasks: [...(await current())].reverse() }, may, /reordering tasks is reserved/);
  await refuse({ interfaces: [] }, ["add_task"], /changing interfaces needs "amend_interfaces"/);
  await refuse({ title: "Renamed" }, may, /changing title is reserved to the orchestrator/);
  await refuse({ scope: { paths: ["src/**"] } }, may, /changing scope is reserved/);
  await refuse({ validation: { commands: [{ id: "test", argv: ["true"], timeout_s: 60 }] } }, may, /changing validation is reserved/);
  await refuse({ authority: { may: ["retry"] } }, may, /changing authority is reserved/);
  await refuse({ budget: { max_parallel: 5 } }, ["extend_budget"], /changing budget\.max_parallel is reserved/);
  // Decreases and new caps are the orchestrator's, even with no actions at all.
  await refuse({ budget: { usd: 0.01, per_task_usd: 0.01 } }, [], /lowering budget\.usd to 0\.01 is reserved/);
  await refuse({ budget: { wall_clock_min: 0.001 } }, [], /lowering budget\.wall_clock_min to 0\.001 is reserved/);
  await refuse({ budget: { per_agent_usd: 0.001 } }, [], /adding budget\.per_agent_usd is reserved/);
  // A task budget above per_task_usd is invalid, so a lead cannot hand one to a subcontract task.
  await assert.rejects(amendContract(store, { tasks: [...(await current()), { ...extra, id: "big", kind: "subcontract", budget_usd: 1000 }] }, { by: cfo, authority: ["add_task"] }),
    /tasks\[3\]\.budget_usd \(\$1000\) must not exceed budget\.per_task_usd/);
  const extended = await amendContract(store, { budget: { usd: 11 } }, { by: cfo, authority: ["extend_budget"] });
  assert.equal(extended.contract.budget.usd, 11, "within authority: pre-consented, so no consent round is needed");
  // Raising again stays bounded by the budget first frozen (10 → at most 11), not by the latest.
  await refuse({ budget: { usd: 12 } }, ["extend_budget"], /beyond the 10% extension limit \(11\)/);
  const reassigned = await amendContract(store, { tasks: (await current()).map((x) => (x.id === "tests" ? { ...x, persona: skeptic } : x)) }, { by: cfo, authority: ["reassign"] });
  assert.deepEqual(reassigned.affected.changed, ["tests"]);
  // A new persona may join as a participant with add_task or reassign, if it resolves.
  const withOps = await amendContract(store, { tasks: [...(await current()), { ...extra, id: "ops-task", persona: ops, paths: { write: ["src/ops/**"] } }] }, { by: cfo, authority: ["add_task"] });
  assert.ok(withOps.contract.participants.some((p) => p.agent === ops));
  await assert.rejects(amendContract(store, { tasks: [...(await current()), { ...extra, id: "ghost-task", persona: "/nonexistent/ghost.md", paths: { write: ["src/ghost/**"] } }] }, { by: cfo, authority: ["add_task"] }),
    /ghost\.md/);
  assert.deepEqual(authorityNeeds(r.contract, r.contract, []), []);
});

test("a run-wide change to a frozen contract: refused without consent, applied only if everyone agrees, or overridden with an audit", async (t) => {
  let skepticSays = "Consent: AGREE\nok";
  provider(t, (agent) => (agent === "skeptic" ? skepticSays : "Consent: AGREE\nok"));
  const r = await propose({ consent: true });
  await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  await assert.rejects(amendContract(store, { budget: { usd: 20 } }, { by: "main", reason: "more" }), /changing budget of a frozen contract touches every participant/);
  skepticSays = "Consent: OBJECT\ntoo much";
  await assert.rejects(amendContract(store, { budget: { usd: 20, per_task_usd: 5 } }, { by: "main", reason: "more", consent: llm }),
    /skeptic\.md objects to v2: too much\n- the change to budget was not applied/);
  assert.equal((await contractRecord(store)).version, 1, "nothing was applied");
  skepticSays = "Consent: AGREE\nfine";
  const ok = await amendContract(store, { budget: { usd: 20, per_task_usd: 5 } }, { by: "main", reason: "more", consent: llm });
  assert.equal(ok.version, 2);
  assert.deepEqual(ok.asked, [cfo, skeptic]);
  assert.deepEqual(ok.consent.agree, [cfo, skeptic], "the candidate's verdicts are current once it is applied");
  assert.equal((await store.state()).contract.budget.usd, 20);
  const over = await amendContract(store, { sandbox: { backend: "docker", image: "node:24" } }, { by: "main", reason: "newer node", overrideConsent: true });
  assert.equal(over.version, 3);
  assert.ok(auditEntries().some((e) => e.target === r.contractId && e.action === "contract.consent_overridden" && e.details.fields.includes("sandbox")));
  // A task-level change applies at once.
  const tl = await amendContract(store, { tasks: baseTasks().map((x) => (x.id === "ui" ? { ...x, acceptance: ["renders", "empty state"] } : x)) }, { by: "main", reason: "empty state" });
  assert.equal(tl.version, 4);
});
test("amend from_session: the session's roundtable-tasks block replaces the structure", async (t) => {
  const r = await propose();
  const id = "ultraplan-replan01";
  const plan = blockText({ tasks: [baseTasks()[0], { ...baseTasks()[1], title: "Orders page v2" }], commands: [{ id: "test", argv: ["npm", "run", "test:ci"] }] });
  archiveSession({ id, kind: "ultraplan", agents: [cfo], topic: "Replan", started: new Date().toISOString(), turns: [],
    document: { markdown: plan, signedOff: true, version: 1, planner: "orchestrator", versions: [{ version: 1, plan, author: "orchestrator", at: new Date().toISOString() }], entries: [], signoffs: [], tally: {} },
    public: null });
  const a = await amendContract(await openContractStore(r.contractId), {}, { by: "main", reason: "replan", fromSession: id });
  assert.equal(a.contract.tasks[1].title, "Orders page v2");
  assert.deepEqual(a.contract.validation.commands[0].argv, ["npm", "run", "test:ci"]);
  assert.deepEqual(a.contract.validation.final, ["test"]);
  assert.deepEqual(a.affected.all, ["api", "ui"], "both tasks run the changed check command");
  await assert.rejects(amendContract(await openContractStore(r.contractId), {}, { by: "main", fromSession: "collab-noblock1" }), /from_session not found/);
});

test("an empty patch with consent asks only the participants without an agreement", async (t) => {
  const r = await propose();
  const calls = provider(t, answers({ cfo: ["Consent: AGREE\nok"], skeptic: ["Consent: AGREE\nok"] }));
  const store = await openContractStore(r.contractId);
  const a = await amendContract(store, {}, { by: "main", reason: "consent", consent: llm });
  assert.equal(a.version, 1, "no new version");
  assert.deepEqual(a.asked, [cfo, skeptic]);
  assert.equal(a.consent.ready, true);
  assert.equal(calls.length, 2);
  const again = await amendContract(store, {}, { by: "main", reason: "consent", consent: llm });
  assert.deepEqual(again.asked, []);
  assert.ok(again.warnings.some((w) => /already agreed/.test(w)));
  assert.equal(summarizeConsent(await contractRecord(store)).ready, true);
});

// ---------------------------------------------------------------------------
// Tool layer
// ---------------------------------------------------------------------------

test("tools: propose, amend and freeze through handleToolCall", async (t) => {
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  for (const name of ["propose_contract", "amend_contract", "freeze_contract"]) {
    assert.equal(byName[name].inputSchema.additionalProperties, false, name);
    assert.equal(typeof byName[name].annotations.title, "string");
  }
  assert.deepEqual(byName.propose_contract.inputSchema.required, ["goal", "orchestrator"]);
  assert.deepEqual(byName.amend_contract.inputSchema.required, ["contract_id", "patch", "reason", "orchestrator"]);
  assert.deepEqual(byName.freeze_contract.inputSchema.required, ["contract_id", "orchestrator"]);
  const err = async (name, args) => (await handleToolCall(name, args)).content[0].text;
  assert.equal(await err("propose_contract", { goal: "g" }), 'Error: propose_contract: "orchestrator" is required: name yourself, e.g. main');
  assert.equal(await err("propose_contract", { goal: " ", orchestrator: "main" }), 'Error: propose_contract: "goal" is required: state the ultimate goal the contract delivers');
  assert.match(await err("propose_contract", { goal: "g", orchestrator: "main", surprise: 1 }), /"surprise" is not allowed \(expected: goal, orchestrator/);
  assert.equal(await err("propose_contract", { goal: "g", orchestrator: "main", parent_task: "x" }), "Error: propose_contract: parent_contract and parent_task go together");
  assert.equal(await err("propose_contract", { goal: "g", orchestrator: "main", provider: "openai", base_url: "http://x.test/v1" }), 'Error: base_url is only supported with provider "openai_compatible" (got "openai")');
  assert.equal(await err("freeze_contract", { contract_id: "ctr-abc123-1", orchestrator: "main", excuse: [{ agent: "a" }] }), 'Error: freeze_contract: "excuse[0].reason" is required');
  assert.equal(await err("amend_contract", { contract_id: "ctr-abc123-1", orchestrator: "main", reason: "r" }), 'Error: amend_contract: "patch" is required');

  const proposed = await handleToolCall("propose_contract", {
    goal: "Ship the orders page", orchestrator: "main", original_prompt: "ship it", repo_dir: repoDir, contract: explicit(), artifacts: ["docs/spec.md", "https://example.com/x"],
  });
  assert.equal(proposed.isError, undefined, proposed.content[0].text);
  const text = proposed.content[0].text;
  assert.match(text, /^## Contract ctr-[0-9a-z]{6}-1 v1 \(draft\)\n\nConsent: 0 of 2 agreed to v1; no answer yet from/);
  assert.ok(text.includes("# Contract: Ship the orders page"));
  const summary = JSON.parse(/```json\n([\s\S]*)\n```$/.exec(text)[1]);
  assert.equal(summary.status, "draft");
  assert.equal(summary.source, "explicit");
  assert.ok(summary.files.markdown.endsWith("CONTRACT.md"));
  const id = summary.contract_id;
  assert.deepEqual((await contractRecord(await openContractStore(id))).contract.goal.artifacts, [{ kind: "file", ref: "docs/spec.md" }, { kind: "url", ref: "https://example.com/x" }]);
  assert.match(await err("freeze_contract", { contract_id: id, orchestrator: "main" }), /^Error: Cannot freeze ctr-[0-9a-z]{6}-1:\n- .*has not consented/);
  provider(t, answers({ cfo: ["Consent: AGREE\nok"], skeptic: ["Consent: AGREE\nok"] }));
  const consent = await handleToolCall("amend_contract", { contract_id: id, patch: {}, reason: "consent", orchestrator: "main", consent: true, ...{ provider: "openai_compatible", model: "m", base_url: LLM } });
  assert.match(consent.content[0].text, /Consent: 2 of 2 agreed to v1/);
  const frozen = await handleToolCall("freeze_contract", { contract_id: id, orchestrator: "main" });
  assert.match(frozen.content[0].text, /^## Contract .* v1 \(frozen\)\n\nConsent: 2 of 2 agreed to v1\nFrozen sha256: [0-9a-f]{64}/);
  // A run-wide change to a frozen contract needs everyone's consent first, or an audited override.
  assert.match(await err("amend_contract", { contract_id: id, patch: { budget: { usd: 12 } }, reason: "more room", orchestrator: "main" }),
    /changing budget of a frozen contract touches every participant: pass consent: true .* or override_consent: true/);
  const amended = await handleToolCall("amend_contract", { contract_id: id, patch: { budget: { usd: 12 } }, reason: "more room", orchestrator: "main", override_consent: true });
  assert.match(amended.content[0].text, /v2 \(frozen\)/);
  assert.match(amended.content[0].text, /Affected tasks: none/);
  assert.match(amended.content[0].text, /consent overridden for the change to budget \(audited\)/);
  assert.match(amended.content[0].text, /Not asked about v2: /);
  assert.ok(auditEntries().some((e) => e.target === id && e.action === "contract.consent_overridden" && e.details.fields[0] === "budget"));
  assert.match(await err("amend_contract", { contract_id: "ctr-zzzzzz-1", patch: {}, reason: "r", orchestrator: "main" }), /Contract ctr-zzzzzz-1 not found/);
});

// ---------------------------------------------------------------------------
// Review findings: stale rounds, crashed rounds, sources, hashes, sibling budgets
// ---------------------------------------------------------------------------

test("a late answer from a superseded round is dropped, never credited to the newer version", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider(t, async (agent, body) => {
    if (/` v1\)/.test(body.messages[1].content)) {
      await gate;
      return "Consent: AGREE\nv1 looked fine";
    }
    return "Consent: OBJECT\nv2 breaks my task";
  });
  const r = await propose();
  const store = await openContractStore(r.contractId);
  const late = requestConsent(store, r.contractId, { by: "main", llm }); // a round on v1 whose answers are held back
  let first;
  while (!(first = (await store.events({ types: ["contract.consent_requested"] }))[0])) await new Promise((resolve) => setTimeout(resolve, 5));
  // Another process would see that round as stale: drop this process's marker and move the clock on.
  endConsentRound(first.payload.round);
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + 3 * 3600_000);
  const changed = baseTasks().map((x) => ({ ...x, acceptance: [...x.acceptance, "and drop auth"] }));
  const a = await amendContract(store, { tasks: changed }, { by: "main", reason: "change both", consent: llm });
  assert.equal(a.version, 2);
  assert.deepEqual(a.consent.objections.map((o) => o.verdict), ["OBJECT", "OBJECT"]);
  release();
  const stale = await late;
  assert.match(stale.dropped, /a newer consent round .* started meanwhile/);
  const rec = await contractRecord(store);
  assert.deepEqual(Object.values(rec.verdicts).map((v) => `${v.verdict}@v${v.version}`), ["OBJECT@v2", "OBJECT@v2"]);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /objects: v2 breaks my task/);
  // Answers naming another round, or a second answer from the same participant, are ignored on replay too.
  const second = (await store.events({ types: ["contract.consent_requested"] })).at(-1).payload.round;
  await store.transact(() => ({ events: [
    { type: "contract.consent_recorded", source: { kind: "orchestrator", id: "main", pid: 1 }, contract_version: 2, payload: { contract: r.contractId, agent: cfo, verdict: "AGREE", round: first.payload.round } },
    { type: "contract.consent_recorded", source: { kind: "orchestrator", id: "main", pid: 1 }, contract_version: 2, payload: { contract: r.contractId, agent: cfo, verdict: "AGREE", round: second } },
  ] }));
  const after = await contractRecord(store);
  assert.equal(after.verdicts[cfo].verdict, "OBJECT");
  assert.equal(after.ignored, 2);
});

test("a crashed round: the stale window is capped, a dead owner on this host ends it at once, abandon_round is audited", async () => {
  assert.ok(consentRoundStaleMs(50) <= CONSENT_ROUND_STALE_CAP_MS);
  assert.equal(CONSENT_ROUND_STALE_CAP_MS, 10 * 60_000);
  const r = await propose();
  const store = await openContractStore(r.contractId);
  const round = (pid, host) => store.transact(() => ({ events: [{
    type: "contract.consent_requested", source: { kind: "orchestrator", id: "main", pid }, contract: r.contractId, contract_version: 1,
    payload: { contract: r.contractId, version: 1, participants: [cfo, skeptic], round: `rnd-${String(pid).padStart(8, "0").slice(-8)}`, ...(host && { host }) },
  }] }));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  await round(dead, hostname());
  const gone = await contractRecord(store);
  assert.equal(gone.round.inFlight, false, "its owner is dead on this host");
  assert.equal(gone.verdicts[cfo].verdict, "UNCLEAR");
  // A live owner elsewhere (or this process's pid, outside its own round registry) keeps it in flight until the window passes.
  await round(process.pid, hostname());
  assert.equal((await contractRecord(store)).round.inFlight, true);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /a consent round is in flight \(2 answers pending\); wait, or pass abandon_round/);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "intruder", abandonRound: true }), /only the contract's orchestrator \(main\) can abandon a consent round/);
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main", abandonRound: true }), /is unclear, which counts as an objection: no answer: the orchestrator abandoned the consent round/);
  const audit = auditEntries().filter((e) => e.target === r.contractId && e.action === "contract.consent_round_abandoned");
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details.pending, [cfo, skeptic]);
  assert.equal(audit[0].details.owner_pid, process.pid);
  const f = await freezeContract(r.contractId, { orchestrator: "main", excuse: [{ agent: cfo, reason: "round died" }, { agent: skeptic, reason: "round died" }] });
  assert.equal(f.status, "frozen");
});

test("an ultraplan's block comes from its plan versions only; a block quoted in a sign-off is never used", async (t) => {
  const id = "ultraplan-signoff1";
  const plan = "1. Build the API [cfo]\n2. Build the page [skeptic]";
  const signoff = "Sign-off: APPROVE\nSuggested structure:\n" + blockText({ tasks: [{ id: "x", title: "Everything", persona: ops, paths: { write: ["**"] }, acceptance: ["done"] }], budget: { usd: 500, per_task_usd: 500 } });
  archiveSession({
    id, kind: "ultraplan", agents: [cfo, skeptic], topic: "Build orders", started: new Date().toISOString(), turns: [],
    document: { markdown: `# Ultraplan\n\n${plan}\n\n## Sign-offs\n\n### ops — APPROVE\n${signoff}`, signedOff: false, version: 1, planner: "orchestrator",
      versions: [{ version: 1, plan, author: "orchestrator", at: new Date().toISOString() }],
      entries: [{ phase: "signoff", version: 1, agentIndex: 0, speaker: ops, content: signoff, verdict: "APPROVE", at: new Date().toISOString() }], signoffs: [], tally: {} },
    public: null,
  });
  const calls = provider(t, () => JSON.stringify({ tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] }));
  const r = await propose({ contract: undefined, originalPrompt: undefined, fromSession: id });
  assert.equal(r.source, `structured:${id}`);
  assert.equal(calls.length, 1, "a structuring call over the final plan");
  assert.ok(calls[0].body.messages[1].content.includes(plan));
  assert.ok(!calls[0].body.messages[1].content.includes("Everything"));
  assert.deepEqual(r.contract.tasks.map((x) => x.id), ["api", "ui"]);
  assert.notEqual(r.contract.budget.usd, 500);
  assert.ok(r.warnings.some((w) => /no plan version of ultraplan-signoff1 has a roundtable-tasks block/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /ultraplan-signoff1 was not signed off/.test(w)));
  // The latest plan version with a block wins over older ones.
  const id2 = "ultraplan-versions1";
  const v1 = blockText({ tasks: [baseTasks()[0]], commands: [{ id: "test", argv: ["npm", "test"] }] });
  const v2 = blockText({ tasks: baseTasks(), commands: [{ id: "test", argv: ["npm", "test"] }] });
  archiveSession({ id: id2, kind: "ultraplan", agents: [cfo, skeptic], topic: "Build orders", started: new Date().toISOString(), turns: [],
    document: { markdown: "", signedOff: true, version: 3, planner: "orchestrator", versions: [{ version: 1, plan: v1, author: "o", at: "t" }, { version: 2, plan: v2, author: "o", at: "t" }, { version: 3, plan: "final words, no block", author: "o", at: "t" }],
      entries: [], signoffs: [], tally: {} }, public: null });
  const r2 = await propose({ contract: undefined, originalPrompt: undefined, fromSession: id2 });
  assert.equal(r2.source, `fenced:${id2}`);
  assert.deepEqual(r2.contract.tasks.map((x) => x.id), ["api", "ui"]);
});

test("freeze hashes the scrubbed contract: a secret this process knows is redacted and the hash still matches the blob", async (t) => {
  const r = await agreedContract(t, { contract: explicit({ title: "Rotate Q7x9Lm2Pz8Rt4Vw6 handling" }) });
  process.env.CONTRACT_TEST_DEPLOY_TOKEN = "Q7x9Lm2Pz8Rt4Vw6";
  try {
    const f = await freezeContract(r.contractId, { orchestrator: "main" });
    const store = await openContractStore(r.contractId);
    const ev = (await store.events({ types: ["contract.frozen"] }))[0];
    const blob = JSON.parse((await store.getBlob(ev.payload.blob)).toString("utf8"));
    assert.doesNotMatch(blob.title, /Q7x9Lm2Pz8Rt4Vw6/);
    assert.equal(contractHash(blob), ev.payload.hash);
    assert.equal(f.hash, ev.payload.hash);
    assert.equal(blob.frozen.hash, ev.payload.hash);
  } finally {
    delete process.env.CONTRACT_TEST_DEPLOY_TOKEN;
  }
});

test("sibling child contracts share their parent task's cap, which the parent's remaining budget also bounds", async (t) => {
  const sub = { id: "sub", title: "Sub", persona: cfo, kind: "subcontract", paths: { write: ["src/sub/**"] }, acceptance: ["done"], checks: [], budget_usd: 4 };
  const parent = await agreedContract(t, { contract: explicit({ tasks: [...baseTasks(), sub] }) });
  const child = (usd, write = "src/sub/x/**") => propose({
    orchestrator: cfo, parentContract: parent.contractId, parentTask: "sub",
    contract: { tasks: [{ id: "x", title: "X", persona: cfo, paths: { write: [write] }, acceptance: ["ok"], checks: [] }], budget: { usd, per_task_usd: usd } },
  });
  const one = await child(3);
  assert.equal(one.contract.budget.usd, 3);
  await assert.rejects(child(2, "src/sub/y/**"), /budget\.usd \(\$2\) plus the task's other child contracts \(\$3\) exceeds what the parent task may spend \(\$4\)/);
  const two = await child(1, "src/sub/y/**");
  assert.equal(two.contract.budget.usd, 1);
  await assert.rejects(child(0.5, "src/sub/z/**"), /plus the task's other child contracts \(\$4\)/);
  // An amendment of a child is checked against its siblings, not against itself.
  const store = await openContractStore(one.contractId);
  await assert.rejects(amendContract(store, { budget: { usd: 3.5, per_task_usd: 3.5 } }, { by: cfo, reason: "more" }), /plus the task's other child contracts \(\$1\)/);
});

test("verdicts are stored as own properties, whatever the agent name", async () => {
  const r = await propose();
  const store = await openContractStore(r.contractId);
  await store.transact(() => ({ events: [
    { type: "contract.consent_recorded", source: { kind: "orchestrator", id: "main", pid: 1 }, contract_version: 1, payload: { contract: r.contractId, agent: "__proto__", verdict: "AGREE" } },
    { type: "contract.objection_resolved", source: { kind: "orchestrator", id: "main", pid: 1 }, contract_version: 1, payload: { contract: r.contractId, agent: "constructor", how: "excused", reason: "x" } },
  ] }));
  const rec = await contractRecord(store);
  assert.equal(Object.hasOwn(rec.verdicts, "__proto__"), true);
  assert.equal(rec.verdicts["__proto__"].verdict, "AGREE");
  assert.equal(Object.hasOwn(rec.verdicts, "constructor"), true);
  assert.equal({}.verdict, undefined);
});

// Duel archives (WS21d-2): the winner becomes a decision, archived dissents become draft concerns.
{
  const { ROUNDTABLE_HOME } = await import("../../dist/config.js");
  const demo = JSON.parse(readFileSync(fileURLToPath(new URL("../../examples/duel/demo.json", import.meta.url)), "utf8"));
  const saveDuel = (id, edit = (a) => a) => {
    mkdirSync(join(ROUNDTABLE_HOME, "duels"), { recursive: true });
    writeFileSync(join(ROUNDTABLE_HOME, "duels", `${id}.json`), JSON.stringify(edit(JSON.parse(JSON.stringify(demo).replaceAll("marketer", skeptic)))));
    return id;
  };
  const setEnd = (a, patch) => { Object.assign(a.events.find((e) => e.type === "end"), patch); return a; };

  test("a duel imports its winner as a decision and its dissents as draft concerns with provenance", async (t) => {
    provider(t, () => "Consent: AGREE");
    const id = saveDuel("duel-00000000-0000-4000-8000-000000000001");
    const r = await propose({ fromSession: id, contract: explicit({ decisions: [] }) });
    const d = r.contract.decisions.find((x) => x.id === "duel-winner");
    assert.match(d.text, /"Ten Coins"/);
    assert.match(d.text, /team A/);
    assert.match(d.rationale, /Covers needs and tradeoffs/);
    assert.equal(d.by, `duel:${id}`);
    assert.doesNotMatch(JSON.stringify(r.contract), /<html|<script/i, "artifact source is never inlined");
    assert.equal(r.duelImport.imported_decision, true);
    assert.equal(r.duelImport.artifact_title, "Ten Coins");
    assert.equal(r.contract.dissents.length, 1);
    const [dis] = r.contract.dissents;
    assert.equal(dis.by, skeptic);
    assert.deepEqual(dis.source, { kind: "duel", ref: id });
    assert.match(dis.claim, /different family budgets/);
    assert.match(dis.predicted_failure, /every household has coins left/);
    assert.equal(dis.tripwire, undefined);
    assert.ok(r.contract.participants.some((p) => p.agent === skeptic));
    // Freeze is blocked until the dissent has a tripwire or an excusal.
    const store = await openContractStore(r.contractId);
    await requestConsent(store, r.contractId, { by: "main", llm });
    await assert.rejects(freezeContract(r.contractId, { orchestrator: "main" }), /needs a tripwire/);
    await fileDissent(store, { ...dis, tripwire: { kind: "check_failed", check: "test", task: "ui" } }, { by: "main" });
    await requestConsent(store, r.contractId, { by: "main", llm });
    const frozen = await freezeContract(r.contractId, { orchestrator: "main" });
    assert.equal(frozen.contract.dissents[0].tripwire.check, "test");
    // An excusal also satisfies the rule.
    const r2 = await propose({ fromSession: id });
    const s2 = await openContractStore(r2.contractId);
    await fileDissent(s2, { id: r2.contract.dissents[0].id }, { by: "main", excuseReason: "Family budgets are out of scope." });
    await requestConsent(s2, r2.contractId, { by: "main", llm });
    assert.ok((await freezeContract(r2.contractId, { orchestrator: "main" })).hash);
  });

  test("a tie or no-winner duel imports no decision and says so", async () => {
    for (const winner of ["tie", "none"]) {
      const id = saveDuel(`duel-${winner}-0001`, (a) => setEnd(a, { winner }));
      const r = await propose({ fromSession: id });
      assert.ok(!r.contract.decisions.some((x) => x.id === "duel-winner"));
      assert.equal(r.duelImport.imported_decision, false);
      assert.ok(r.warnings.some((w) => /no decision was imported.*orchestrator must decide/.test(w)));
      assert.equal(r.contract.dissents.length, 1, "dissents still import");
    }
  });

  test("a bad duel id, traversal or missing archive is rejected; repeated dissents and imports do not duplicate", async () => {
    for (const bad of ["duel-../x", "duel-a/b", "duel-", "DUEL-1", "duel-" + "a".repeat(200), "duel-missing-0001"]) {
      await assert.rejects(propose({ fromSession: bad }), /duel|not found/i, bad);
    }
    const id = saveDuel("duel-dupe-0001", (a) => { a.events.splice(-1, 0, structuredClone(a.events.find((e) => e.type === "dissent"))); return a; });
    const first = await propose({ fromSession: id });
    assert.equal(first.contract.dissents.length, 1, "a repeated archived dissent counts once");
    const again = await propose({ fromSession: id, participants: [cfo, skeptic], contract: explicit({ dissents: first.contract.dissents.map(({ id: i, ...rest }) => ({ id: i, ...rest })) }) });
    assert.equal(again.contract.dissents.length, 1, "an already-carried dissent is not added twice");
  });

  test("an archive without the newer optional fields still imports, and a missing artifact imports no decision", async () => {
    const id = saveDuel("duel-minimal-0001", (a) => { a.events = a.events.filter((e) => e.type !== "prototype"); return a; });
    const r = await propose({ fromSession: id });
    assert.equal(r.duelImport.imported_decision, false);
    assert.match(r.warnings.join("\n"), /archived no artifact/);
  });
}
