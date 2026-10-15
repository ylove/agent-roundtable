// Contract lifecycle (heads-down.md §8): structure sources, propose, consent, freeze, amend, and the tool layer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { json, stubFetch } from "./helpers.mjs";

const { proposeContract, freezeContract, amendContract, resolveRepo, AuthorityError, ContractRefusal, authorityNeeds } =
  await import("../../dist/execution/contract-lifecycle.js");
const { contractRecord, openContractStore, summarizeConsent, consentRoundStaleMs } = await import("../../dist/execution/contract-state.js");
const { buildConsentPrompt, CONSENT_REASK, consentReason } = await import("../../dist/execution/consent.js");
const { findTaskBlock, blockToContract, sessionSource, TASK_BLOCK_TAG } = await import("../../dist/execution/contract-parse.js");
const { contractHash, checkContract } = await import("../../dist/execution/contract.js");
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
  assert.match(r.next, /No consent yet/);
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
  assert.deepEqual(requested, { contract: r.contractId, version: 1, participants: [cfo, skeptic, ops] });
  assert.match(r.next, /Objections: .*Address them with amend_contract/);
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
  await assert.rejects(freezeContract(r.contractId, { orchestrator: "main", excuse: [{ agent: cfo, reason: "x" }] }), /has no objection to excuse/);
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
    /budget\.usd \(\$9\) exceeds the parent task's budget \(\$4\)/);
});

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

test("amending a draft proposes v2; only affected participants and open objectors are re-asked", async (t) => {
  const three = explicit({ tasks: [...baseTasks(), { id: "docs", title: "Docs", persona: ops, paths: { write: ["docs/**"] }, acceptance: ["written"], checks: [] }],
    scope: { paths: ["src/**", "docs/**"] } });
  const calls = provider(t, answers({
    cfo: ["Consent: AGREE\nok"], skeptic: ["Consent: AGREE\nok", "Consent: AGREE\nstill fine"], ops: ["Consent: OBJECT\ndocs too vague", "Consent: AGREE\nclear now"],
  }));
  const r = await propose({ contract: three, consent: true });
  assert.deepEqual(r.consent.objections.map((o) => o.agent), [ops]);
  const store = await openContractStore(r.contractId);
  const tasks = three.tasks.map((x) => (x.id === "docs" ? { ...x, acceptance: ["a README section per endpoint"] } : x));
  const a = await amendContract(store, { tasks }, { by: "main", reason: "make docs concrete", consent: llm });
  assert.equal(a.version, 2);
  assert.equal(a.status, "draft");
  assert.deepEqual(a.affected.changed, ["docs"]);
  assert.deepEqual(a.asked, [ops], "cfo and skeptic are not affected");
  assert.equal(consentRequests(calls).length, 4);
  assert.equal(a.consent.ready, true);
  const proposed = (await store.events({ types: ["contract.proposed"] })).at(-1);
  assert.equal(proposed.payload.version, 2);
  assert.equal(proposed.payload.source, "amendment");
  assert.equal(proposed.payload.reason, "make docs concrete");
  const patch = JSON.parse((await store.getBlob(proposed.payload.patch_blob)).toString("utf8"));
  assert.deepEqual(Object.keys(patch), ["tasks"]);
  const resolved = (await store.events({ types: ["contract.objection_resolved"] })).map((e) => e.payload);
  assert.deepEqual(resolved, [{ contract: r.contractId, agent: ops, how: "amended", reason: "agreed to v2" }]);
  assert.equal((await store.state()).contract, undefined, "a draft amendment does not reach the blackboard");
  // The interface consumers of a changed interface are affected too.
  const b = await amendContract(store, { interfaces: [{ ...three.interfaces[0], description: "GET /orders?page=" }] }, { by: "main", reason: "paging" });
  assert.deepEqual(b.affected.all, ["api", "ui"]);
  await assert.rejects(amendContract(store, {}, { by: "main", reason: "nothing" }), /The patch changes nothing/);
  await assert.rejects(amendContract(store, { id: "x", scope: { repo_root: "/x" }, goal: { original_prompt: "y" } }, { by: "main" }),
    /patch may not change id\n- patch may not change scope\.repo_root\n- patch may not change goal\.original_prompt/);
  await assert.rejects(amendContract(store, { title: "x" }, { by: "intruder" }), /only the contract's orchestrator \(main\) can amend it/);
  await assert.rejects(amendContract(store, { tasks: [{ id: "solo" }] }, { by: "main" }), /The amended contract is not valid/);
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

test("amendContract with an authority: add_task, reassign and extend_budget within the percentage; everything else refused", async (t) => {
  const r = await agreedContract(t, { contract: explicit({ authority: { lead: cfo, may: ["retry", "add_task"], budget_extension_pct: 10 } }) });
  await freezeContract(r.contractId, { orchestrator: "main" });
  const store = await openContractStore(r.contractId);
  const extra = { id: "tests", title: "Tests", persona: cfo, paths: { write: ["src/tests/**"] }, acceptance: ["covers orders"], checks: ["test"] };
  const added = await amendContract(store, { tasks: [...baseTasks(), extra] }, { by: cfo, reason: "goal review: missing tests", authority: ["retry", "add_task"] });
  assert.deepEqual(added.affected.added, ["tests"]);
  const ev = (await store.events({ types: ["contract.amended"] })).at(-1);
  assert.deepEqual([ev.source.kind, ev.source.id], ["agent", cfo]);
  const refuse = async (patch, may, re) => {
    await assert.rejects(amendContract(store, patch, { by: cfo, authority: may }), (e) => {
      assert.ok(e instanceof AuthorityError, String(e));
      assert.ok(e.needs.some((n) => re.test(n)), JSON.stringify(e.needs));
      return true;
    });
  };
  await refuse({ budget: { usd: 11 } }, ["add_task"], /raising budget\.usd to 11 needs "extend_budget"/);
  await refuse({ budget: { usd: 12 } }, ["extend_budget"], /budget\.usd 12 is beyond the 10% extension limit \(11\)/);
  await refuse({ tasks: [baseTasks()[0], extra], interfaces: [{ ...explicit().interfaces[0], consumers: [] }] }, ["add_task"], /removing ui is reserved to the orchestrator/);
  await refuse({ tasks: [...baseTasks(), { ...extra, acceptance: ["other"] }] }, ["add_task"], /changing the spec of tests is reserved/);
  await refuse({ interfaces: [] }, ["add_task"], /changing interfaces needs "amend_interfaces"/);
  await refuse({ title: "Renamed" }, ["add_task"], /changing title is reserved to the orchestrator/);
  await refuse({ budget: { max_parallel: 5 } }, ["extend_budget"], /changing budget\.max_parallel is reserved/);
  const extended = await amendContract(store, { budget: { usd: 11 } }, { by: cfo, authority: ["extend_budget"] });
  assert.equal(extended.contract.budget.usd, 11);
  // Raising again stays bounded by the budget first frozen (10 → at most 11), not by the latest.
  await refuse({ budget: { usd: 12 } }, ["extend_budget"], /beyond the 10% extension limit \(11\)/);
  const reassigned = await amendContract(store, { tasks: [...baseTasks(), { ...extra, persona: skeptic }] }, { by: cfo, authority: ["reassign"] });
  assert.deepEqual(reassigned.affected.changed, ["tests"]);
  assert.deepEqual(authorityNeeds(r.contract, r.contract, []), []);
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
  assert.match(text, /^## Contract ctr-[0-9a-z]{6}-1 v1 \(draft\)\n\nConsent: 0 of 2 agreed; no answer yet from/);
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
  assert.match(consent.content[0].text, /Consent: 2 of 2 agreed/);
  const frozen = await handleToolCall("freeze_contract", { contract_id: id, orchestrator: "main" });
  assert.match(frozen.content[0].text, /^## Contract .* v1 \(frozen\)\n\nConsent: 2 of 2 agreed\nFrozen sha256: [0-9a-f]{64}/);
  const amended = await handleToolCall("amend_contract", { contract_id: id, patch: { budget: { usd: 12 } }, reason: "more room", orchestrator: "main" });
  assert.match(amended.content[0].text, /v2 \(frozen\)/);
  assert.match(amended.content[0].text, /Affected tasks: none/);
  assert.match(await err("amend_contract", { contract_id: "ctr-zzzzzz-1", patch: {}, reason: "r", orchestrator: "main" }), /Contract ctr-zzzzzz-1 not found/);
});
