import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { json, stubFetch } from "./helpers.mjs";

// Configuration is read at import time. Every writable directory belongs to this test.
const root = mkdtempSync(join(tmpdir(), "rt-ultraplan-"));
const log = join(root, "activity.jsonl");
process.env.ROUNDTABLE_ACTIVITY_LOG = log;
process.env.ROUNDTABLE_AGENTS_DIR = join(root, "agents");
process.env.ROUNDTABLE_SKILLS_DIR = join(root, "skills");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = join(root, "transcripts");
process.env.ROUNDTABLE_NTFY_URL = "http://ntfy.test";
process.env.ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS = "5000";
process.env.ROUNDTABLE_PARALLEL_TURNS = "2";
delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
after(() => rmSync(root, { recursive: true, force: true }));

const {
  startUltraplan, submitPlan, endUltraplan, listUltraplans, ultraplans,
  REVIEW_VERDICTS, SIGNOFF_VERDICTS, NEXT_AFTER_INPUT, NEXT_AFTER_REVIEW,
  buildUltraplanParticipantDirective, buildUltraplanPlannerDirective, buildInputPrompt,
  buildReviewPrompt, buildSignoffPrompt, buildPlannerDraftPrompt, buildPlannerRevisePrompt,
  renderUltraplanDocument, recordUltraplanEntry, tallyVerdicts,
} = await import("../../dist/sessions/ultraplan.js");
const { PublicChannel, finalizeOpenChannels } = await import("../../dist/publishers/index.js");
const { readActivity } = await import("../../dist/activity.js");
const { DEFAULT_MODELS } = await import("../../dist/config.js");

const fixtureDir = fileURLToPath(new URL("../fixtures/ultraplan/", import.meta.url));
const fx = (name) => join(fixtureDir, `${name}.md`);
const cfo = fx("cfo");
const skeptic = fx("skeptic");
const ops = fx("ops");
const planner = fx("planner");
const LLM = "http://localhost:1234/v1";
const opts = { provider: "openai_compatible", model: "m", baseUrl: LLM };
const MARKER = "PRIVATE-CONTEXT-ZQX-5531";
const errMessage = "OpenAI-compatible API error (500): phase failed";
const failure = () => json(500, { error: { message: "phase failed" } });
const llmCalls = (calls) => calls.filter((c) => c.url === `${LLM}/chat/completions`);

function details(body) {
  const system = body.messages[0].content;
  const prompt = body.messages[1].content;
  const agent = /You are (\w+)\./.exec(system)?.[1].toLowerCase();
  const authoring = system.includes("## Ultraplan role: planner");
  const phase = authoring ? (prompt.includes("**Current plan") ? "revision" : "draft")
    : prompt.includes("The plan has not been written yet") ? "input"
      : prompt.includes("**Final plan") ? "signoff" : "review";
  const version = Number(/\*\*(?:Current plan|Final plan|Plan) v(\d+)/.exec(prompt)?.[1] ?? 0);
  return { system, prompt, agent, phase, version, body };
}

function reply({ agent, phase, version }) {
  if (phase === "input") return `${agent.toUpperCase()}-INPUT-MARKER\n1. Must cover\n- Concrete input.`;
  if (phase === "draft") return "PLANNER-DRAFT-MARKER\n1. Execute with an owner and acceptance criteria.";
  if (phase === "revision") return `PLANNER-PLAN-v${version + 1}\n1. Execute the revised step.\n\n## Changes from v${version}\n- Addressed amendments.`;
  if (phase === "review") return `Verdict: ${agent === "cfo" ? "APPROVE WITH CHANGES" : "OBJECT"}\n${agent.toUpperCase()}-REVIEW-MARKER-v${version}\nAmendments: 1. Add a check to step 1.`;
  return `Sign-off: ${agent === "skeptic" ? "APPROVE WITH RESERVATIONS" : "APPROVE"}\n${agent.toUpperCase()}-SIGNOFF-MARKER-v${version}`;
}

function responses(t, override) {
  return stubFetch(t, async (url, init, index) => {
    if (url === `${LLM}/chat/completions`) {
      const d = details(JSON.parse(init.body));
      const result = await override?.(d, index);
      return result instanceof Response ? result : json(200, { choices: [{ message: { content: result ?? reply(d) } }] });
    }
    assert.equal(new URL(url).origin, "http://ntfy.test", `Unexpected URL: ${url}`);
    return init.method === "POST" ? json(200, { id: "x", time: 1 }) : new Response("", { status: 200 });
  });
}

afterEach(async () => {
  // Sessions are closed within each test; this also detects accidental orphan sessions.
  assert.equal(ultraplans.size, 0);
  await finalizeOpenChannels();
});

test("orchestrator input, review and final submission preserve order and record a complete document", async (t) => {
  const calls = responses(t);
  const first = await startUltraplan([cfo, skeptic], "Ship the project", { ...opts, context: MARKER });
  assert.equal(first.status, "awaiting_plan");
  assert.equal(first.phase, "input");
  assert.deepEqual(first.input.map((i) => i.agent), [cfo, skeptic]);
  assert.match(first.input[0].content, /CFO-INPUT-MARKER/);
  assert.match(first.input[1].content, /SKEPTIC-INPUT-MARKER/);
  assert.equal(first.next, NEXT_AFTER_INPUT);
  assert.equal(first.plan, undefined);
  assert.equal(llmCalls(calls).length, 2);
  const listing = listUltraplans()[0];
  assert.deepEqual(listing, {
    id: first.ultraplanId, task: "Ship the project", agents: [cfo, skeptic], planner: "orchestrator",
    status: "awaiting_plan", versions: 0, public: false, startedAt: ultraplans.get(first.ultraplanId).startedAt.toISOString(),
    provider: "openai_compatible", model: "m",
  });
  const reviewed = await submitPlan(first.ultraplanId, "  1. Ship with checks.  ");
  assert.equal(reviewed.status, "awaiting_revision");
  assert.equal(reviewed.phase, "review");
  assert.equal(reviewed.version, 1);
  assert.deepEqual(reviewed.reviews.map((r) => r.verdict), ["APPROVE WITH CHANGES", "OBJECT"]);
  assert.deepEqual(reviewed.tally, { APPROVE: 0, "APPROVE WITH CHANGES": 1, OBJECT: 1, UNCLEAR: 0 });
  assert.equal(reviewed.next, NEXT_AFTER_REVIEW);
  assert.equal(reviewed.plan, undefined);
  assert.equal(llmCalls(calls).length, 4);
  assert.equal(ultraplans.get(first.ultraplanId).versions[0].plan, "1. Ship with checks.");
  const final = await submitPlan(first.ultraplanId, "1. Ship with stronger checks.", true);
  assert.equal(final.status, "finalized");
  assert.equal(final.signedOff, true);
  assert.equal(final.version, 2);
  assert.deepEqual(final.signoffs.map((s) => s.agent), [cfo, skeptic]);
  assert.deepEqual(final.tally, { APPROVE: 1, "APPROVE WITH RESERVATIONS": 1, OBJECT: 0, UNCLEAR: 0 });
  assert.match(final.finalPlan, /## Final plan \(v2\)/);
  assert.match(final.finalPlan, /## Sign-offs/);
  assert.match(final.finalPlan, /## Agent input/);
  assert.ok(final.finalPlan.includes(`- v1 by orchestrator — reviews: ${cfo} APPROVE WITH CHANGES, ${skeptic} OBJECT`));
  assert.match(final.finalPlan, /- v2 by orchestrator — final, signed off/);
  assert.deepEqual(listUltraplans(), []);
  assert.equal(llmCalls(calls).length, 6);
  for (const c of llmCalls(calls)) {
    assert.equal(c.body.messages.length, 2, "calls are stateless");
    assert.match(c.body.messages[0].content, /## Ultraplan role: plan contributor/);
    assert.equal(c.body.model, "m");
  }
  assert.equal(calls.length, 6, "private sessions do not publish");
});

test("draftPlan starts with an atomic orchestrator v1 and skips input", async (t) => {
  const calls = responses(t);
  const first = await startUltraplan([cfo, skeptic], "Start from draft", { ...opts, draftPlan: "  Draft text  " });
  assert.equal(first.phase, "review");
  assert.equal(first.status, "awaiting_revision");
  assert.equal(first.version, 1);
  const u = ultraplans.get(first.ultraplanId);
  assert.equal(u.versions[0].author, "orchestrator");
  assert.equal(u.versions[0].plan, "Draft text");
  assert.deepEqual(u.entries.map((e) => e.phase), ["plan", "review", "review"]);
  assert.deepEqual(llmCalls(calls).map((c) => details(c.body).phase), ["review", "review"]);
  const final = await submitPlan(first.ultraplanId, "Revised", true);
  assert.match(final.finalPlan, /\(no input phase: the session started from a draft\)/);
});

test("final true straight after input signs off v1, and whitespace draft is absent", async (t) => {
  const calls = responses(t);
  const first = await startUltraplan([ops], "One step", { ...opts, draftPlan: " \n\t " });
  assert.equal(first.phase, "input");
  const final = await submitPlan(first.ultraplanId, "  Execute. \n", true);
  assert.equal(final.version, 1);
  assert.equal(final.signedOff, true);
  assert.match(final.finalPlan, /## Final plan \(v1\)\n\nExecute\./);
  assert.deepEqual(llmCalls(calls).map((c) => details(c.body).phase), ["input", "signoff"]);
});

test("autonomous planner completes rounds 1 and 2 and clamps rounds 9 to 3", async (t) => {
  const calls = responses(t);
  for (const [requested, rounds] of [[1, 1], [2, 2], [9, 3]]) {
    const before = llmCalls(calls).length;
    const final = await startUltraplan([cfo, skeptic], "Autonomous task", { ...opts, planner, revisionRounds: requested });
    assert.equal(final.status, "finalized");
    assert.equal(final.signedOff, true);
    assert.equal(final.version, rounds + 1);
    const run = llmCalls(calls).slice(before).map((c) => details(c.body));
    assert.equal(run.length, 2 + 1 + rounds * (2 + 1) + 2);
    const draft = run.find((d) => d.phase === "draft");
    assert.match(draft.prompt, /CFO-INPUT-MARKER/);
    assert.match(draft.prompt, /SKEPTIC-INPUT-MARKER/);
    for (const d of run.filter((d) => ["draft", "revision"].includes(d.phase))) {
      assert.match(d.system, /## Ultraplan role: planner/);
      assert.ok(!d.system.includes("## Ultraplan role: plan contributor"));
      if (d.phase === "revision") {
        assert.ok(d.prompt.includes(`### ${cfo} (APPROVE WITH CHANGES)`));
        assert.ok(d.prompt.includes(`### ${skeptic} (OBJECT)`));
      }
    }
    for (let v = 1; v <= rounds + 1; v++) assert.ok(final.finalPlan.includes(`- v${v} by ${planner} —`));
  }
});

test("planner defaults and invalid revision rounds resolve to one round; draft skips input and authoring v1", async (t) => {
  const calls = responses(t);
  for (const requested of [undefined, NaN, 0, -2, 1.9]) {
    const before = llmCalls(calls).length;
    const final = await startUltraplan([cfo], "Draft autonomous", { ...opts, planner, draftPlan: "Original", revisionRounds: requested });
    assert.equal(final.version, 2);
    const run = llmCalls(calls).slice(before).map((c) => details(c.body));
    assert.deepEqual(run.map((d) => d.phase), ["review", "revision", "signoff"]);
    assert.match(final.finalPlan, /- v1 by orchestrator — reviews:/);
    assert.ok(final.finalPlan.includes(`- v2 by ${planner} — final, signed off`));
  }
});

test("planner can also participate using a separate contributor directive", async (t) => {
  const calls = responses(t);
  const final = await startUltraplan([planner, cfo], "Dual role", { ...opts, planner });
  const plannerCalls = llmCalls(calls).map((c) => details(c.body)).filter((d) => d.agent === "planner");
  assert.deepEqual(plannerCalls.map((d) => d.phase), ["input", "draft", "review", "revision", "signoff"]);
  for (const d of plannerCalls) assert.ok(d.system.includes(d.phase === "draft" || d.phase === "revision"
    ? "## Ultraplan role: planner" : "## Ultraplan role: plan contributor"));
  assert.equal(final.signoffs[0].agent, planner);
  assert.deepEqual(readActivity(log).find((e) => e.session === final.ultraplanId).agents, ["planner", "cfo"]);
});

test("review and sign-off tallies include UNCLEAR, bold verdicts and every zero key", async (t) => {
  responses(t, (d) => {
    if (d.phase === "review") return d.agent === "cfo" ? "No verdict\nNeeds checks." : "**Verdict:** OBJECT\nA blocker.";
    if (d.phase === "signoff") return d.agent === "cfo" ? "No sign-off\nNeeds checks." : "**Sign-off:** OBJECT\nStill blocked.";
  });
  const first = await startUltraplan([cfo, skeptic], "Unclear", opts);
  const reviewed = await submitPlan(first.ultraplanId, "Plan");
  assert.deepEqual(reviewed.tally, { APPROVE: 0, "APPROVE WITH CHANGES": 0, OBJECT: 1, UNCLEAR: 1 });
  assert.deepEqual(reviewed.reviews.map((r) => r.verdict), ["UNCLEAR", "OBJECT"]);
  const final = await submitPlan(first.ultraplanId, "Final", true);
  assert.deepEqual(final.tally, { APPROVE: 0, "APPROVE WITH RESERVATIONS": 0, OBJECT: 1, UNCLEAR: 1 });
  assert.match(final.finalPlan, /Sign-off: 0 approve, 0 approve with reservations, 1 object, 1 unclear/);
  assert.equal(readActivity(log).find((e) => e.session === final.ultraplanId).outcome,
    "signed off v2: 0 approve, 0 approve with reservations, 1 object, 1 unclear");
  assert.deepEqual(tallyVerdicts(["APPROVE", "unknown", "UNCLEAR"], REVIEW_VERDICTS),
    { APPROVE: 1, "APPROVE WITH CHANGES": 0, OBJECT: 0, UNCLEAR: 2 });
});

test("failed review and sign-off leave the entire session unchanged and retries do not duplicate versions", async (t) => {
  let failing;
  responses(t, (d) => d.agent === "skeptic" && d.phase === failing ? failure() : undefined);
  const first = await startUltraplan([cfo, skeptic], "Atomic phases", opts);
  const u = ultraplans.get(first.ultraplanId);
  for (const phase of ["review", "signoff"]) {
    failing = phase;
    const before = structuredClone(u);
    await assert.rejects(submitPlan(u.id, "  Candidate  ", phase === "signoff"), { message: errMessage });
    assert.deepEqual(u, before);
    failing = undefined;
    const expectedVersion = before.versions.length + 1;
    const result = await submitPlan(u.id, "  Candidate  ", phase === "signoff");
    assert.equal(result.version, expectedVersion);
    assert.equal(u.versions.length, expectedVersion);
    assert.deepEqual(u.versions.map((v) => v.version), Array.from({ length: expectedVersion }, (_, i) => i + 1));
  }
});

test("failed first input or draft-review deletes the session and finalizes its public header", async (t) => {
  const rec = t.mock.method(PublicChannel.prototype, "record");
  const fin = t.mock.method(PublicChannel.prototype, "finalize");
  const calls = responses(t, (d) => d.agent === "skeptic" ? failure() : undefined);
  for (const options of [opts, { ...opts, planner }, { ...opts, draftPlan: "Draft" }, { ...opts, planner, draftPlan: "Draft" }]) {
    const before = rec.mock.calls.length;
    await assert.rejects(startUltraplan([cfo, skeptic], "First failure", { ...options, public: true }), { message: errMessage });
    assert.equal(ultraplans.size, 0);
    assert.deepEqual(rec.mock.calls.slice(before).map((c) => c.arguments[0].kind), ["header"]);
    await finalizeOpenChannels();
  }
  assert.ok(fin.mock.calls.length >= 4);
  assert.equal(calls.filter((c) => c.url.startsWith("http://ntfy.test") && c.init.method === "POST").length, 4);
});

test("planner failures return the last committed state and can be continued by the orchestrator", async (t) => {
  let failing;
  const calls = responses(t, (d) => d.phase === failing && (d.agent === "planner" || d.agent === "skeptic") ? failure() : undefined);
  for (const [phase, step, versions, countReviews] of [
    ["draft", "draft", 0, 0], ["review", "review of v1", 1, 0],
    ["revision", "revision to v2", 1, 2], ["signoff", "sign-off", 2, 0],
  ]) {
    failing = phase;
    const result = await startUltraplan([cfo, skeptic], "Resume autonomous", { ...opts, planner });
    assert.equal(result.error, `Planner run stopped during ${step}: ${errMessage}. The session is open: continue with submit_plan or close with end_ultraplan.`);
    assert.equal(result.status, versions ? "awaiting_revision" : "awaiting_plan");
    assert.equal(result.phase, versions ? (countReviews ? "review" : "plan") : "input");
    const u = ultraplans.get(result.ultraplanId);
    assert.equal(listUltraplans()[0].versions, versions);
    assert.equal(u.versions.length, versions);
    if (versions) {
      assert.equal(result.plan, u.versions.at(-1).plan);
      assert.equal(result.reviews.length, countReviews);
      assert.deepEqual(result.tally, countReviews ? { APPROVE: 0, "APPROVE WITH CHANGES": 1, OBJECT: 1, UNCLEAR: 0 }
        : undefined);
    } else {
      assert.equal(result.plan, undefined);
      assert.equal(result.input.length, 2);
    }
    failing = undefined;
    const final = await submitPlan(result.ultraplanId, "Caller takes over", true);
    assert.equal(final.version, versions + 1);
  }
  assert.ok(llmCalls(calls).length > 0);
});

test("empty planner draft and revision keep the provider's actionable error and commit no empty plan", async (t) => {
  let failing;
  responses(t, (d) => d.phase === failing
    ? json(200, { choices: [{ message: { content: "  \n " }, finish_reason: "length" }] }) : undefined);
  for (const phase of ["draft", "revision"]) {
    failing = phase;
    const result = await startUltraplan([cfo], "Empty planner", { ...opts, planner });
    const step = phase === "draft" ? "draft" : "revision to v2";
    assert.ok(result.error.startsWith(`Planner run stopped during ${step}: `), result.error);
    assert.match(result.error, /returned no text \(finish reason: length\)\..*ROUNDTABLE_MAX_TOKENS/);
    assert.ok(result.error.endsWith(". The session is open: continue with submit_plan or close with end_ultraplan."));
    assert.equal(ultraplans.get(result.ultraplanId).versions.length, phase === "draft" ? 0 : 1);
    await endUltraplan(result.ultraplanId);
  }
});

test("endUltraplan closes with an unsigned latest plan or no plan and all-zero sign-off tally", async (t) => {
  responses(t);
  const first = await startUltraplan([cfo], "Unsigned version", { ...opts, draftPlan: "Draft" });
  const end = await endUltraplan(first.ultraplanId);
  assert.equal(end.signedOff, false);
  assert.equal(end.version, 1);
  assert.deepEqual(end.signoffs, []);
  assert.deepEqual(end.tally, { APPROVE: 0, "APPROVE WITH RESERVATIONS": 0, OBJECT: 0, UNCLEAR: 0 });
  assert.match(end.finalPlan, /Not signed off/);
  assert.match(end.finalPlan, /## Latest plan \(v1\) — not signed off/);
  assert.match(end.finalPlan, /\(none: the session was closed without sign-off\)/);
  assert.equal(readActivity(log).find((e) => e.session === first.ultraplanId).outcome, "ended without sign-off at v1");
  const second = await startUltraplan([cfo], "No version", opts);
  const noPlan = await endUltraplan(second.ultraplanId);
  assert.equal(noPlan.version, null);
  assert.match(noPlan.finalPlan, /## Plan\n\nNo plan was submitted\./);
  assert.match(noPlan.finalPlan, /\(no plan versions\)/);
  assert.equal(readActivity(log).find((e) => e.session === second.ultraplanId).outcome, "ended without a plan");
});

test("validation uses exact errors, unknown ids list active ids, and all personas load before calls", async (t) => {
  const calls = responses(t);
  await assert.rejects(startUltraplan([], "Task", opts), { message: "Ultraplan requires at least 1 agent" });
  await assert.rejects(startUltraplan([cfo], " \n ", opts), { message: "task is required: describe what the plan is for" });
  await assert.rejects(startUltraplan(undefined, "Task", opts), { message: "Ultraplan requires at least 1 agent" });
  await assert.rejects(startUltraplan([cfo], undefined, opts), { message: "task is required: describe what the plan is for" });
  for (const options of [{}, { planner: join(root, "missing.md") }]) {
    const agents = options.planner ? [cfo] : [cfo, join(root, "missing.md")];
    await assert.rejects(startUltraplan(agents, "Missing persona", { ...opts, ...options, public: true }), /Agent prompt not found/);
    assert.equal(calls.length, 0);
    assert.equal(ultraplans.size, 0);
  }
  await assert.rejects(submitPlan("nope", ""), { message: "Ultraplan not found: nope. Active ultraplans: none" });
  await assert.rejects(endUltraplan("nope"), { message: "Ultraplan not found: nope. Active ultraplans: none" });
  const a = await startUltraplan([cfo], "A", opts);
  const b = await startUltraplan([ops], "B", opts);
  const message = `Ultraplan not found: nope. Active ultraplans: ${a.ultraplanId}, ${b.ultraplanId}`;
  await assert.rejects(submitPlan("nope", ""), { message });
  await assert.rejects(endUltraplan("nope"), { message });
  await assert.rejects(submitPlan(a.ultraplanId, " \n "), { message: "No plan version exists yet; pass plan." });
  await endUltraplan(a.ultraplanId);
  await endUltraplan(b.ultraplanId);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("busy guard rejects concurrent submit and end while start or submit is running", async (t) => {
  let hold;
  let entered;
  responses(t, async (d) => {
    if (hold) {
      entered.resolve();
      await hold.promise;
    }
  });
  for (const plannerOption of [undefined, planner]) {
    hold = deferred();
    entered = deferred();
    const pending = startUltraplan([cfo], "In flight", { ...opts, ...(plannerOption && { planner: plannerOption }) });
    await entered.promise;
    const id = listUltraplans()[0].id;
    const message = `Ultraplan ${id} is busy: a phase is still running. Wait for it to finish, then retry.`;
    await assert.rejects(submitPlan(id), { message });
    await assert.rejects(endUltraplan(id), { message });
    const releasing = hold;
    hold = undefined;
    releasing.resolve();
    const first = await pending;
    if (plannerOption) continue;
    hold = deferred();
    entered = deferred();
    const submitting = submitPlan(id, "Plan");
    await entered.promise;
    await assert.rejects(submitPlan(id, undefined, true), { message });
    await assert.rejects(endUltraplan(id), { message });
    const releaseSubmit = hold;
    hold = undefined;
    releaseSubmit.resolve();
    await submitting;
    await endUltraplan(first.ultraplanId);
  }
});

test("a failed phase waits for all in-flight calls before releasing the guard", async (t) => {
  const entered = deferred();
  const release = deferred();
  let fail = false;
  responses(t, async (d) => {
    if (fail && d.phase === "review") {
      if (d.agent === "cfo") return failure();
      entered.resolve();
      await release.promise;
    }
  });
  const first = await startUltraplan([cfo, skeptic], "Settle all calls", opts);
  const before = structuredClone(ultraplans.get(first.ultraplanId));
  fail = true;
  const pending = submitPlan(first.ultraplanId, "Candidate");
  const rejected = assert.rejects(pending, { message: errMessage });
  await entered.promise;
  await assert.rejects(endUltraplan(first.ultraplanId), /is busy/);
  assert.deepEqual(ultraplans.get(first.ultraplanId), before);
  release.resolve();
  await rejected;
  assert.deepEqual(ultraplans.get(first.ultraplanId), before);
  await endUltraplan(first.ultraplanId);
});

test("participant prompts contain only their own earlier input and review, never same-phase outputs", async (t) => {
  const calls = responses(t);
  const first = await startUltraplan([cfo, skeptic, ops], "Independent views", { ...opts, context: MARKER });
  await submitPlan(first.ultraplanId, "First candidate");
  await submitPlan(first.ultraplanId, "Second candidate");
  await submitPlan(first.ultraplanId, "Final candidate", true);
  for (const c of llmCalls(calls)) {
    const d = details(c.body);
    const text = `${d.system}\n${d.prompt}`;
    for (const other of ["cfo", "skeptic", "ops"].filter((a) => a !== d.agent)) {
      assert.ok(!text.includes(`${other.toUpperCase()}-INPUT-MARKER`));
      assert.ok(!text.includes(`${other.toUpperCase()}-REVIEW-MARKER`));
      assert.ok(!text.includes(`${other.toUpperCase()}-SIGNOFF-MARKER`));
    }
    if (d.phase !== "input") assert.ok(text.includes(`${d.agent.toUpperCase()}-INPUT-MARKER`));
    if (d.phase === "review" && d.version === 2) assert.ok(text.includes(`${d.agent.toUpperCase()}-REVIEW-MARKER-v1`));
    if (d.phase === "review") assert.ok(!text.includes(`${d.agent.toUpperCase()}-REVIEW-MARKER-v${d.version}`));
    if (d.phase === "signoff") assert.ok(!text.includes("SIGNOFF-MARKER"));
  }
});

test("duplicate participant refs route their own input and previous review by agentIndex", async (t) => {
  let inputIndex = 0;
  let reviewIndex = 0;
  const calls = responses(t, (d) => {
    if (d.phase === "input") return `DUP-INPUT-${inputIndex++}`;
    if (d.phase === "review") return `Verdict: APPROVE\nDUP-REVIEW-${reviewIndex++}`;
  });
  const first = await startUltraplan([cfo, cfo], "Repeated ref", opts);
  await submitPlan(first.ultraplanId, "Plan 1");
  await submitPlan(first.ultraplanId, "Plan 2");
  await submitPlan(first.ultraplanId, "Plan 3", true);
  const run = llmCalls(calls).map((c) => details(c.body));
  for (const [i, d] of run.filter((d) => d.phase === "review" && d.version === 2).entries()) {
    assert.ok(d.prompt.includes(`DUP-INPUT-${i}`));
    assert.ok(!d.prompt.includes(`DUP-INPUT-${1 - i}`));
    assert.ok(d.prompt.includes(`DUP-REVIEW-${i}`));
    assert.ok(!d.prompt.includes(`DUP-REVIEW-${1 - i}`));
  }
  for (const [i, d] of run.filter((d) => d.phase === "signoff").entries()) {
    assert.ok(d.prompt.includes(`DUP-INPUT-${i}`));
    assert.ok(!d.prompt.includes(`DUP-INPUT-${1 - i}`));
  }
});

test("public mirror commits ordered entries, uses path-free labels and excludes context", async (t) => {
  const rec = t.mock.method(PublicChannel.prototype, "record");
  const calls = responses(t, async (d) => {
    // The later participant finishes first; records must still be in participant order.
    if (d.agent === "cfo") await new Promise((r) => setTimeout(r, 5));
  });
  const first = await startUltraplan([cfo, skeptic], "Public topic", { ...opts, context: MARKER, public: true });
  assert.deepEqual(first.input.map((i) => i.agent), ["cfo", "skeptic"]);
  assert.ok(first.public.url.startsWith("http://ntfy.test/"));
  const reviewed = await submitPlan(first.ultraplanId, "Public plan v1");
  assert.deepEqual(reviewed.reviews.map((r) => r.agent), ["cfo", "skeptic"]);
  assert.deepEqual(reviewed.public, first.public);
  const final = await submitPlan(first.ultraplanId, "Public final", true);
  const entries = rec.mock.calls.map((c) => c.arguments[0]);
  assert.deepEqual(entries.map((e) => e.kind), ["header", "turn", "turn", "caller", "turn", "turn", "caller", "turn", "turn", "summary"]);
  assert.deepEqual(entries.slice(1, -1).map((e) => e.speaker), [
    "cfo · input", "skeptic · input", "orchestrator · plan v1", "cfo · review of v1", "skeptic · review of v1",
    "orchestrator · plan v2", "cfo · sign-off", "skeptic · sign-off",
  ]);
  assert.deepEqual(entries.map((e) => e.turn), Array.from({ length: entries.length }, (_, i) => i));
  assert.match(entries[0].content, /planner: orchestrator/);
  assert.equal(entries.at(-1).content, final.finalPlan);
  assert.match(final.publicBlock, /Public transcript: http:\/\/ntfy\.test\//);
  assert.deepEqual(final.signoffs.map((s) => s.agent), ["cfo", "skeptic"]);
  assert.match(final.finalPlan, /Planner: orchestrator · Participants: cfo, skeptic/);
  const posts = calls.filter((c) => c.url.startsWith("http://ntfy.test") && c.init.method === "POST");
  assert.deepEqual(posts.map((c) => c.body.title), [
    "#00 · session", "#01 · cfo input", "#02 · skeptic input", "#03 · orchestrator plan v1", "#04 · cfo review of v1",
    "#05 · skeptic review of v1", "#06 · orchestrator plan v2", "#07 · cfo sign-off", "#08 · skeptic sign-off", "#09 · summary",
  ]);
  for (const c of calls.filter((c) => c.url.startsWith("http://ntfy.test"))) {
    assert.ok(!JSON.stringify(c).includes(MARKER));
    assert.ok(!JSON.stringify(c).includes(fixtureDir));
  }
  for (const c of llmCalls(calls)) {
    assert.match(c.body.messages[0].content, /PUBLIC SESSION NOTICE/);
    assert.ok(!JSON.stringify(c.body ?? "").includes(fixtureDir));
  }
  assert.ok(llmCalls(calls).some((c) => c.body.messages[1].content.includes(MARKER)));
});

test("public autonomous planner labels its role and publishes its plans as turns", async (t) => {
  const rec = t.mock.method(PublicChannel.prototype, "record");
  const calls = responses(t);
  const final = await startUltraplan([cfo], "Public autonomous", { ...opts, planner, public: true, context: MARKER });
  const entries = rec.mock.calls.map((c) => c.arguments[0]);
  assert.match(entries[0].content, /planner: planner/);
  const plans = entries.filter((e) => e.speaker.startsWith("planner · plan"));
  assert.deepEqual(plans.map((e) => [e.speaker, e.kind]), [["planner · plan v1", "turn"], ["planner · plan v2", "turn"]]);
  assert.match(final.finalPlan, /Planner: planner · Participants: cfo/);
  assert.match(final.finalPlan, /- v2 by planner — final, signed off/);
  assert.ok(final.publicBlock);
  for (const c of calls) {
    assert.ok(!JSON.stringify(c.body ?? "").includes(fixtureDir));
    if (c.url.startsWith("http://ntfy.test")) assert.ok(!JSON.stringify(c).includes(MARKER));
    else assert.match(c.body.messages[0].content, /PUBLIC SESSION NOTICE/);
  }
});

test("failed public phase posts no plan or partial replies until a successful retry", async (t) => {
  const rec = t.mock.method(PublicChannel.prototype, "record");
  let failing = false;
  responses(t, (d) => failing && d.agent === "skeptic" && d.phase === "review" ? failure() : undefined);
  const first = await startUltraplan([cfo, skeptic], "Atomic public", { ...opts, public: true });
  const before = rec.mock.calls.length;
  failing = true;
  await assert.rejects(submitPlan(first.ultraplanId, "Failed candidate"), /phase failed/);
  assert.equal(rec.mock.calls.length, before);
  failing = false;
  await submitPlan(first.ultraplanId, "Successful candidate");
  assert.deepEqual(rec.mock.calls.slice(before).map((c) => c.arguments[0].kind), ["caller", "turn", "turn"]);
  await endUltraplan(first.ultraplanId);
});

test("activity records the finalized id, canonical participant and planner keys, topic, mode and public flag", async (t) => {
  responses(t);
  const first = await startUltraplan([cfo, skeptic], "Activity task", opts);
  const final = await submitPlan(first.ultraplanId, "Final activity plan", true);
  const entry = readActivity(log).find((e) => e.session === final.ultraplanId);
  assert.deepEqual({ ...entry, at: undefined }, {
    at: undefined, session: first.ultraplanId, kind: "ultraplan", mode: "orchestrator", agents: ["cfo", "skeptic"],
    topic: "Activity task", outcome: "signed off v1: 1 approve, 1 approve with reservations, 0 object", public: false,
  });
  const publicFinal = await startUltraplan([cfo], "Public activity", { ...opts, planner, public: true });
  const publicEntry = readActivity(log).find((e) => e.session === publicFinal.ultraplanId);
  assert.equal(publicEntry.public, true);
  assert.equal(publicEntry.mode, "planner");
  assert.deepEqual(publicEntry.agents, ["cfo", "planner"]);
  assert.match(publicEntry.outcome, /^signed off v2:/);
  assert.equal(readActivity(log).filter((e) => e.session === publicFinal.ultraplanId).length, 1);
});

test("provider and model resolve like collaborations, while baseUrl remains pinned", async (t) => {
  const calls = responses(t);
  const first = await startUltraplan([cfo], "Default model", { provider: "openai_compatible", baseUrl: LLM });
  assert.equal(ultraplans.get(first.ultraplanId).model, DEFAULT_MODELS.openai_compatible);
  assert.equal(llmCalls(calls)[0].body.model, DEFAULT_MODELS.openai_compatible);
  process.env.OPENAI_COMPATIBLE_BASE_URL = "http://must-not-be-used.test/v1";
  t.after(() => { delete process.env.OPENAI_COMPATIBLE_BASE_URL; });
  await submitPlan(first.ultraplanId, "Pinned plan", true);
  assert.ok(llmCalls(calls).every((c) => c.url === `${LLM}/chat/completions`));
});

test("agent skills apply to participant and planner prompts and keys come from resolved paths", async (t) => {
  mkdirSync(process.env.ROUNDTABLE_AGENTS_DIR, { recursive: true });
  mkdirSync(process.env.ROUNDTABLE_SKILLS_DIR, { recursive: true });
  writeFileSync(join(process.env.ROUNDTABLE_AGENTS_DIR, "subagent-Skilled.md"), "---\nname: Skilled\nskills: [budget]\n---\nYou are Cfo.");
  mkdirSync(join(process.env.ROUNDTABLE_SKILLS_DIR, "budget"), { recursive: true });
  writeFileSync(join(process.env.ROUNDTABLE_SKILLS_DIR, "budget", "SKILL.md"), "BUDGET-SKILL-MARKER");
  const calls = responses(t);
  const final = await startUltraplan(["Skilled"], "Skilled task", { ...opts, planner: "Skilled" });
  for (const c of llmCalls(calls)) {
    assert.match(c.body.messages[0].content, /BUDGET-SKILL-MARKER/);
    assert.ok(!c.body.messages[0].content.includes("skills: [budget]"));
  }
  assert.deepEqual(readActivity(log).find((e) => e.session === final.ultraplanId).agents, ["skilled"]);
});

function documentSession(extra = {}) {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "ultraplan-doc", task: "  " + "T".repeat(130) + "\nPrivate second task line", agents: [{ name: "/private/personas/cfo.md", key: "cfo", systemPrompt: "persona" }],
    planner: { name: "/private/personas/planner.md", key: "planner", systemPrompt: "planner" },
    provider: "openai_compatible", model: "m", status: "awaiting_revision", startedAt: at,
    versions: [
      { version: 1, plan: "First plan", author: "orchestrator", timestamp: at },
      { version: 2, plan: "Unreviewed plan", author: "/private/personas/planner.md", timestamp: at },
      { version: 3, plan: "Final plan text", author: "/private/personas/planner.md", timestamp: at },
    ],
    entries: [
      { phase: "input", agentIndex: 0, speaker: "/private/personas/cfo.md", content: "I".repeat(6001), timestamp: at },
      { phase: "review", agentIndex: 0, version: 1, speaker: "/private/personas/cfo.md", content: "Review", verdict: "APPROVE WITH CHANGES", timestamp: at },
    ],
    publicChannel: { url: null, topic: "doc", record() {} },
    ...extra,
  };
}

test("document rendering has exact blocks, title truncation, input truncation and all history forms", () => {
  const u = documentSession();
  const signoffs = [
    { agent: "/private/personas/cfo.md", verdict: "APPROVE", content: "Agreed" },
    { agent: "skeptic", verdict: "APPROVE WITH RESERVATIONS", content: "Monitor" },
    { agent: "ops", verdict: "UNCLEAR", content: "Unclear" },
  ];
  const doc = renderUltraplanDocument(u, signoffs, true);
  assert.equal(doc.split("\n")[0], "# Ultraplan: " + "T".repeat(119) + "…");
  assert.ok(!doc.includes("Private second task line"));
  assert.ok(!doc.includes("/private/personas/"));
  assert.match(doc, /Planner: planner · Participants: cfo · Plan versions: 3 · Sign-off: 1 approve, 1 approve with reservations, 0 object, 1 unclear/);
  assert.ok(doc.includes("## Final plan (v3)\n\nFinal plan text\n\n## Sign-offs\n\n### cfo — APPROVE\nAgreed"));
  assert.ok(doc.includes("## Agent input\n\n### cfo\n" + "I".repeat(6000) + "\n…[truncated]"));
  assert.ok(!doc.includes("I".repeat(6001)));
  assert.ok(doc.endsWith("## Revision history\n\n- v1 by orchestrator — reviews: cfo APPROVE WITH CHANGES\n- v2 by planner — not reviewed\n- v3 by planner — final, signed off"));
  const unsigned = renderUltraplanDocument(u, [], false);
  assert.match(unsigned, /## Latest plan \(v3\) — not signed off/);
  assert.match(unsigned, /- v3 by planner — not reviewed/);
  const empty = renderUltraplanDocument(documentSession({ task: "Short\nExtra", versions: [], entries: [] }), [], false);
  assert.match(empty, /^# Ultraplan: Short\n/);
  assert.match(empty, /## Plan\n\nNo plan was submitted\./);
  assert.match(empty, /\(no input phase: the session started from a draft\)/);
  assert.match(empty, /\(no plan versions\)/);
  assert.ok(!/\n\n\n/.test(doc), "one blank line between blocks");
});

test("recording choke point appends once and catches a throwing public mirror", (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const u = documentSession({ entries: [], publicChannel: { record() { throw new Error("mirror broke"); } } });
  const entry = { phase: "input", agentIndex: 0, speaker: cfo, content: "Input", timestamp: new Date() };
  assert.equal(recordUltraplanEntry(u, entry), entry);
  assert.deepEqual(u.entries, [entry]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /public record failed: mirror broke/);
});

test("prompt builders include directives, exact verdict choices and optional sections only when supplied", () => {
  assert.ok(buildUltraplanParticipantDirective().startsWith("\n\n## Ultraplan role: plan contributor\n"));
  assert.match(buildUltraplanParticipantDirective(), /never rewrite the whole plan/);
  assert.match(buildUltraplanParticipantDirective(), /outside your expertise/);
  assert.ok(buildUltraplanPlannerDirective().startsWith("\n\n## Ultraplan role: planner\n"));
  assert.match(buildUltraplanPlannerDirective(), /must say why/);
  const input = buildInputPrompt("Task", ["a", "b"], "Context");
  for (const phrase of ["not been written yet", "**Task:** Task", "**Participants:** a, b", "**Context:**", "1. Must cover", "2. Recommended approach", "3. Risks and dependencies", "4. Would make me object", "Bullets, no preamble."]) assert.ok(input.includes(phrase));
  assert.ok(!buildInputPrompt("Task", []).includes("**Context:**"));
  assert.ok(!buildInputPrompt("Task", [], "  ").includes("**Context:**"));
  const review = buildReviewPrompt("Task", "Context", "Plan", 2, "planner", "Own input", "Earlier review");
  for (const phrase of ["**Plan v2 (by planner):**", "**Your input before the draft:**", "**Your previous review:**", "Verdict: APPROVE | APPROVE WITH CHANGES | OBJECT", "Amendments:", "Blocking concerns:", "Check:", "whether your earlier input was reflected", "whether your previous review was addressed", "Don't rewrite the plan. Don't repeat points that are already handled."]) assert.ok(review.includes(phrase));
  const minimalReview = buildReviewPrompt("Task", undefined, "Plan", 1, "orchestrator");
  for (const section of ["**Context:**", "**Your input before the draft:**", "**Your previous review:**"]) assert.ok(!minimalReview.includes(section));
  assert.match(minimalReview, /whether anything important is missing/);
  const signoff = buildSignoffPrompt("Task", "Plan", 3, "Own input");
  for (const phrase of ["**Final plan v3:**", "**Your input before the draft:**", "Sign-off: APPROVE | APPROVE WITH RESERVATIONS | OBJECT", "Reflected from my input:", "Still missing or disagree:", "Watch:", "Brief."]) assert.ok(signoff.includes(phrase));
  assert.ok(!buildSignoffPrompt("Task", "Plan", 1).includes("**Your input before the draft:**"));
  const draft = buildPlannerDraftPrompt("Task", "Context", ["a", "b"], [{ agent: "a", content: "Input a" }]);
  for (const phrase of ["Write plan v1", "### a\nInput a", "numbered steps", "owner/role", "sequencing and dependencies", "acceptance criteria", "risks with mitigations", "open questions", "[a, b]", "Output the plan only."]) assert.ok(draft.includes(phrase));
  assert.ok(!buildPlannerDraftPrompt("Task", undefined, [], []).includes("**Context:**"));
  const revise = buildPlannerRevisePrompt("Task", "Plan", 2, [{ agent: "a", verdict: "OBJECT", content: "Review" }]);
  for (const phrase of ["Write plan v3", "### a (OBJECT)\nReview", "accept, modify or reject", "## Changes from v2", "one-line reason for each rejection"]) assert.ok(revise.includes(phrase));
  assert.equal(NEXT_AFTER_INPUT, "Write plan v1 that incorporates this input. Tag each step with the agents whose input shaped it, e.g. [cfo]. Then call submit_plan; pass final: true to go straight to sign-off.");
  assert.equal(NEXT_AFTER_REVIEW, "Revise the plan to address the amendments (say which you rejected and why), then call submit_plan again, or submit_plan with final: true to collect sign-offs and close.");
  assert.deepEqual(REVIEW_VERDICTS, ["APPROVE", "APPROVE WITH CHANGES", "OBJECT"]);
  assert.deepEqual(SIGNOFF_VERDICTS, ["APPROVE", "APPROVE WITH RESERVATIONS", "OBJECT"]);
});

test("planner v2 review failure exposes unreviewed plan and recovers without a new version", async (t) => {
  let fail = true;
  responses(t, d => fail && d.phase === "review" && d.version === 2 ? failure() : undefined);
  const stopped = await startUltraplan([cfo, skeptic], "Recover review", { ...opts, planner, revisionRounds: 2 });
  t.after(() => ultraplans.clear());
  assert.equal(stopped.phase, "plan");
  assert.equal(stopped.version, 2);
  assert.deepEqual(stopped.reviews, []);
  assert.equal(stopped.tally, undefined);
  assert.equal(stopped.previousReviews.version, 1);
  assert.deepEqual(stopped.previousReviews.reviews.map(r => r.verdict), ["APPROVE WITH CHANGES", "OBJECT"]);
  assert.equal(stopped.next, "Plan v2 has not been reviewed yet. Call submit_plan without a plan to have v2 reviewed as-is, with a revised plan, or with final: true (plan optional) to collect sign-offs.");
  const u = ultraplans.get(stopped.ultraplanId);
  assert.equal(stopped.plan, u.versions[1].plan);
  fail = false;
  const reviewed = await submitPlan(u.id);
  assert.equal(reviewed.version, 2);
  assert.equal(reviewed.phase, "review");
  assert.equal(u.versions.length, 2);
  assert.equal(u.entries.filter(e => e.phase === "plan").length, 2);
  const final = await submitPlan(u.id, undefined, true);
  assert.equal(final.version, 2);
  assert.ok(final.finalPlan.includes(`- v2 by ${planner} — final, signed off`));
  assert.ok(!final.finalPlan.includes("v3"));
});

test("planner sign-off failure recovers on v2 and retains context through draft start", async (t) => {
  let fail = true;
  const calls = responses(t, d => fail && d.phase === "signoff" ? failure() : undefined);
  const stopped = await startUltraplan([cfo], "Recover sign-off", { ...opts, planner, draftPlan: "Draft", context: MARKER });
  t.after(() => ultraplans.clear());
  assert.equal(stopped.phase, "plan");
  fail = false;
  const final = await submitPlan(stopped.ultraplanId, undefined, true);
  assert.equal(final.version, 2);
  assert.ok(!final.finalPlan.includes("v3"));
  for (const d of llmCalls(calls).map(c => details(c.body)).filter(d => ["revision", "signoff"].includes(d.phase))) {
    assert.ok(d.prompt.includes("**Context:**"));
    assert.ok(d.prompt.includes(MARKER));
  }
  assert.ok(buildSignoffPrompt("Task", "Plan", 1, undefined, "Constraint").includes("**Context:**\nConstraint"));
  assert.ok(buildPlannerRevisePrompt("Task", "Plan", 1, [], "Constraint").includes("**Context:**\nConstraint"));
  assert.ok(!buildSignoffPrompt("Task", "Plan", 1).includes("**Context:**"));
  assert.ok(!buildPlannerRevisePrompt("Task", "Plan", 1, []).includes("**Context:**"));
});

test("absent and invalid plans give actionable errors without changing session", async (t) => {
  responses(t);
  const first = await startUltraplan([cfo], "Need a version", opts);
  t.after(() => ultraplans.clear());
  const u = ultraplans.get(first.ultraplanId);
  const before = structuredClone(u);
  for (const plan of [undefined, null, "", " \n "]) {
    await assert.rejects(submitPlan(u.id, plan), { message: "No plan version exists yet; pass plan." });
    assert.deepEqual(u, before);
  }
  for (const plan of [42, {}, []]) {
    await assert.rejects(submitPlan(u.id, plan), { message: "plan must be a string: the full text of the next plan version" });
    assert.deepEqual(u, before);
  }
  await submitPlan(u.id, "First version");
  for (const plan of [null, "", " "]) assert.equal((await submitPlan(u.id, plan)).version, 1);
  await endUltraplan(u.id);
});

test("failed no-plan phases are atomic and repeated reviews use latest verdict per agent index", async (t) => {
  let fail;
  let latest = false;
  responses(t, d => {
    if (d.phase === fail && d.agent === "skeptic") return failure();
    if (latest && d.phase === "review") return "Verdict: APPROVE\nLatest review";
  });
  const first = await startUltraplan([cfo, skeptic, cfo], "Repeat review", { ...opts, draftPlan: "Draft" });
  t.after(() => ultraplans.clear());
  const u = ultraplans.get(first.ultraplanId);
  for (const phase of ["review", "signoff"]) {
    fail = phase;
    const before = structuredClone(u);
    await assert.rejects(submitPlan(u.id, undefined, phase === "signoff"), { message: errMessage });
    assert.deepEqual(u, before);
    fail = undefined;
    latest = true;
    const result = await submitPlan(u.id, undefined, phase === "signoff");
    assert.equal(result.version, 1);
    assert.equal(u.versions.length, 1);
    if (phase === "review") {
      assert.deepEqual(result.reviews.map(r => r.agent), [cfo, skeptic, cfo]);
      assert.deepEqual(result.reviews.map(r => r.verdict), ["APPROVE", "APPROVE", "APPROVE"]);
      assert.equal(result.tally.APPROVE, 3);
      const doc = renderUltraplanDocument(u, [], false);
      assert.ok(doc.includes(`- v1 by orchestrator — reviews: ${cfo} APPROVE, ${skeptic} APPROVE, ${cfo} APPROVE`));
      assert.ok(!doc.includes("APPROVE WITH CHANGES"));
    }
  }
});


test("no-plan review and sign-off hold the busy guard until all calls settle", async (t) => {
  let hold;
  let entered;
  responses(t, async () => {
    if (hold) { entered.resolve(); await hold.promise; }
  });
  const first = await startUltraplan([cfo], "Guard existing version", { ...opts, draftPlan: "Draft" });
  t.after(() => ultraplans.clear());
  for (const final of [false, true]) {
    hold = deferred();
    entered = deferred();
    const pending = submitPlan(first.ultraplanId, undefined, final);
    await entered.promise;
    await assert.rejects(submitPlan(first.ultraplanId), /is busy/);
    await assert.rejects(submitPlan(first.ultraplanId, 42), /is busy/);
    await assert.rejects(endUltraplan(first.ultraplanId), /is busy/);
    const release = hold;
    hold = undefined;
    release.resolve();
    assert.equal((await pending).version, 1);
  }
});

test("a replacement sent straight to sign-off keeps context after a draft start", async (t) => {
  const calls = responses(t);
  const first = await startUltraplan([cfo], "Respect constraints", { ...opts, draftPlan: "Original", context: MARKER });
  await submitPlan(first.ultraplanId, "Replacement", true);
  const signoff = llmCalls(calls).map(c => details(c.body)).find(d => d.phase === "signoff");
  assert.ok(signoff.prompt.includes("**Context:**\n" + MARKER));
  assert.ok(signoff.prompt.includes("Replacement"));
});
