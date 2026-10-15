import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
// Scrubbing replaces the values of secret-named environment variables, so pin the environment: drop
// every secret-named variable the developer or CI happens to have (this file runs in its own process),
// then set one known secret whose exact value must never reach archived content.
const { SECRET_NAME_RE } = await import("../../dist/security/child-env.js");
for (const name of Object.keys(process.env)) if (SECRET_NAME_RE.test(name)) delete process.env[name];
const ENV_SECRET = "archive-test-value-8f3k2q";
process.env.ROUNDTABLE_ARCHIVE_TEST_TOKEN = ENV_SECRET;

const { startMeeting, continueMeeting, endMeeting, meetings } = await import("../../dist/sessions/meetings.js");
const { continueLocalMeeting, endLocalMeeting, localMeetings } = await import("../../dist/sessions/local-meetings.js");
const { startCollaboration, continueCollaboration, nudgeCollaboration, endCollaboration, collaborations, MAX_COLLABORATION_ROUNDS } =
  await import("../../dist/sessions/collaborations.js");
const { startUltraplan, submitPlan, endUltraplan, listUltraplans, ultraplans } = await import("../../dist/sessions/ultraplan.js");
const { createAgent } = await import("../../dist/sessions/agent-creation.js");
const { SessionBusyError, isSessionBusy, lockSession, sessionBusyMessage, withSessionLock } = await import("../../dist/sessions/lock.js");
const archive = await import("../../dist/sessions/archive.js");
const { SESSIONS_DIR } = await import("../../dist/config.js");
const { handleToolCall } = await import("../../dist/tools.js");

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => resolve(here, "../fixtures/agents", n);
const sample = fx("sample.md");
const plain = fx("plain.md");
const LLM = "http://localhost:1234/v1";
const opts = { provider: "openai_compatible", model: "m", baseUrl: LLM };
const reply = (text = "reply") => json(200, { choices: [{ message: { content: text } }] });
const RANDOM = "[0-9a-hjkmnp-tv-z]{8}";

describe("durable random session ids", () => {
  test("meetings, collaborations and ultraplans get <prefix>-<8 random chars>, never a counter", async (t) => {
    stubFetch(t, () => reply());
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const m = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", LLM);
      const c = await startCollaboration([sample, plain], "topic", { ...opts, maxRounds: 1 });
      const u = await startUltraplan([sample], "task", opts);
      ids.push(m.meetingId, c.collaborationId, u.ultraplanId);
      await endMeeting(m.meetingId);
      await endCollaboration(c.collaborationId);
      await endUltraplan(u.ultraplanId);
    }
    for (const [i, id] of ids.entries()) {
      const prefix = ["meeting", "collab", "ultraplan"][i % 3];
      assert.match(id, new RegExp(`^${prefix}-${RANDOM}$`));
    }
    assert.equal(new Set(ids).size, ids.length);
  });
});

/** A fetch stub whose replies wait for gate.release() once gate.arm() was called; arm() returns "wait until entered". */
function gatedFetch(t) {
  const gate = { hold: false, waiting: 0 };
  let entered = () => {};
  let released = Promise.resolve();
  gate.arm = () => {
    gate.hold = true;
    gate.waiting = 0;
    const enteredP = new Promise((r) => (entered = r));
    released = new Promise((r) => (gate.release = () => { gate.hold = false; r(); }));
    return () => enteredP;
  };
  gate.calls = stubFetch(t, async () => {
    if (gate.hold) {
      gate.waiting++;
      entered();
      await released;
    }
    return reply();
  });
  return gate;
}
const text = (r) => r.content[0].text;

describe("per-session locks", () => {
  test("lockSession refuses a second holder at once; release is idempotent; withSessionLock releases on throw", async () => {
    const release = lockSession("collab-locktest", "busy now");
    assert.equal(isSessionBusy("collab-locktest"), true);
    assert.throws(() => lockSession("collab-locktest", "second"), (e) => e instanceof SessionBusyError && e.message === "second" && e.sessionId === "collab-locktest");
    await assert.rejects(withSessionLock("collab-locktest", "third", () => "never"), { message: "third" });
    release();
    release();
    assert.equal(isSessionBusy("collab-locktest"), false);
    await assert.rejects(withSessionLock("collab-locktest", "m", () => { throw new Error("inner"); }), { message: "inner" });
    assert.equal(isSessionBusy("collab-locktest"), false);
    assert.equal(await withSessionLock("collab-locktest", "m", async () => 42), 42);
    assert.equal(sessionBusyMessage("Meeting", "meeting-x"), "Meeting meeting-x is busy: a turn is still running. Wait for it to finish, then retry.");
  });

  test("concurrent continue_collaboration: the second call is refused at once, read-only tools and pause still work", async (t) => {
    const gate = gatedFetch(t);
    const start = JSON.parse(text(await handleToolCall("start_collaboration", {
      agents: [sample, plain], topic: "race", max_rounds: 4, provider: "openai_compatible", model: "m", base_url: LLM,
    })));
    const id = start.collaborationId;
    const entered = gate.arm();
    const first = handleToolCall("continue_collaboration", { collaboration_id: id, rounds: 1 });
    await entered();
    const busy = `Error: Collaboration ${id} is busy: a turn is still running. Wait for it to finish, then retry.`;
    const before = gate.calls.length;
    for (const [tool, args] of [
      ["continue_collaboration", { collaboration_id: id, rounds: 1 }],
      ["nudge_collaboration", { collaboration_id: id, message: "redirect" }],
      ["end_collaboration", { collaboration_id: id, request_summary: true }],
    ]) {
      const r = await handleToolCall(tool, args);
      assert.equal(r.isError, true, tool);
      assert.equal(text(r), busy, tool);
    }
    assert.equal(gate.calls.length, before, "a refused call never reaches the provider");
    assert.equal(collaborations.get(id).messages.length, 1, "nothing recorded by refused calls");
    assert.match(text(await handleToolCall("get_collaboration_transcript", { collaboration_id: id })), /reply/);
    assert.match(text(await handleToolCall("list_collaborations", {})), new RegExp(id));
    assert.equal(gate.waiting, 1, "only the first continue is waiting on the provider");
    gate.release();
    const done = JSON.parse(text(await first));
    assert.equal(done.newMessages.length, 2);
    assert.equal(collaborations.get(id).messages.length, 3);
    // pause is allowed while a turn is in flight: the run stops after the current turn.
    const entered2 = gate.arm();
    const second = handleToolCall("continue_collaboration", { collaboration_id: id, rounds: 2 });
    await entered2();
    assert.match(text(await handleToolCall("pause_collaboration", { collaboration_id: id })), /paused/);
    gate.release();
    const paused = JSON.parse(text(await second));
    assert.equal(paused.status, "paused");
    assert.equal(paused.newMessages.length, 1);
    assert.equal(isSessionBusy(id), false);
    assert.match(text(await handleToolCall("end_collaboration", { collaboration_id: id })), /Collaboration Transcript/);
  });

  test("say and end_meeting are refused while a meeting turn is in flight; the lock is freed when it settles", async (t) => {
    const gate = gatedFetch(t);
    const m = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", LLM);
    const entered = gate.arm();
    const turn = continueMeeting(m.meetingId, "first");
    await entered();
    const busy = `Error: Meeting ${m.meetingId} is busy: a turn is still running. Wait for it to finish, then retry.`;
    assert.equal(text(await handleToolCall("say", { meeting_id: m.meetingId, message: "second" })), busy);
    assert.equal(text(await handleToolCall("end_meeting", { meeting_id: m.meetingId })), busy);
    assert.match(text(await handleToolCall("list_meetings", {})), new RegExp(m.meetingId));
    gate.release();
    await turn;
    assert.equal(meetings.get(m.meetingId).messages.length, 4);
    assert.equal(await continueMeeting(m.meetingId, "third"), "reply");
    await endMeeting(m.meetingId);
  });

  test("say_local and end_local_meeting take the same lock", async () => {
    const release = lockSession("local-locktest", "held by a turn");
    const busy = "Local meeting local-locktest is busy: a turn is still running. Wait for it to finish, then retry.";
    await assert.rejects(continueLocalMeeting("local-locktest", "hi"), { message: busy });
    await assert.rejects(endLocalMeeting("local-locktest"), { message: busy });
    assert.equal(text(await handleToolCall("say_local", { meeting_id: "local-locktest", message: "hi" })), `Error: ${busy}`);
    release();
    await assert.rejects(continueLocalMeeting("local-locktest", "hi"), { message: "Local meeting not found: local-locktest" });
  });

  test("ultraplan phases hold the shared registry, so any caller can ask whether a session is busy", async (t) => {
    const gate = gatedFetch(t);
    const entered = gate.arm();
    const pending = startUltraplan([sample], "In flight", opts);
    await entered();
    const id = listUltraplans().at(-1).id;
    assert.equal(isSessionBusy(id), true);
    assert.equal(text(await handleToolCall("end_ultraplan", { ultraplan_id: id })),
      `Error: Ultraplan ${id} is busy: a phase is still running. Wait for it to finish, then retry.`);
    gate.release();
    await pending;
    assert.equal(isSessionBusy(id), false);
    await endUltraplan(id);
  });
});

describe("collaboration rounds cap", () => {
  test("the schemas declare maximum 20 and the validator enforces it before any provider call", async (t) => {
    const calls = stubFetch(t, () => reply());
    assert.equal(MAX_COLLABORATION_ROUNDS, 20);
    const base = { agents: [sample, plain], topic: "t", provider: "openai_compatible", model: "m", base_url: LLM };
    const over = await handleToolCall("start_collaboration", { ...base, max_rounds: 21 });
    assert.equal(text(over), 'Error: start_collaboration: "max_rounds" must be at most 20');
    const more = await handleToolCall("continue_collaboration", { collaboration_id: "collab-any", rounds: 50 });
    assert.equal(text(more), 'Error: continue_collaboration: "rounds" must be at most 20');
    assert.equal(calls.length, 0);
    const ok = JSON.parse(text(await handleToolCall("start_collaboration", { ...base, max_rounds: 20 })));
    assert.equal(collaborations.get(ok.collaborationId).maxRounds, 20);
    await endCollaboration(ok.collaborationId);
  });

  test("the engine enforces the same cap for in-process callers", async (t) => {
    const calls = stubFetch(t, () => reply());
    await assert.rejects(startCollaboration([sample, plain], "t", { ...opts, maxRounds: 21 }), { message: "max_rounds must be at most 20 (got 21)" });
    assert.equal(calls.length, 0);
    const c = await startCollaboration([sample, plain], "t", { ...opts, maxRounds: 2 });
    await assert.rejects(continueCollaboration(c.collaborationId, 25), { message: "rounds must be at most 20 (got 25)" });
    assert.equal(isSessionBusy(c.collaborationId), false);
    await endCollaboration(c.collaborationId);
  });
});

const archivedFile = (id) => join(SESSIONS_DIR, `${id}.json`);
const scripted = (t, ...outputs) => {
  const calls = stubFetch(t, () => {
    assert.ok(outputs.length, "Unexpected provider call");
    return reply(outputs.shift());
  });
  return calls;
};

describe("session archive", () => {
  test("archiveSession writes a private record: content is scrubbed, ids and agent refs are kept exactly", (t) => {
    const id = "collab-arch0001";
    // A ref that happens to contain the secret value must survive: from_session loads it again.
    const ref = `/agents/${ENV_SECRET}/cfo.md`;
    const path = archive.archiveSession({
      id, kind: "collaboration", mode: "collaborate", agents: [ref, "skeptic"], topic: `Budget ${ENV_SECRET}`,
      started: "2026-10-01T10:00:00.000Z", ended: "2026-10-01T11:00:00.000Z",
      turns: [
        { role: "agent", agent: ref, speaker: "cfo", content: `Key is ${ENV_SECRET} and sk-ant-abcdefghijklmnop` },
        { role: "orchestrator", speaker: "orchestrator", content: "focus" },
      ],
      summary: `Agreed on ${ENV_SECRET}`, public: null,
    });
    assert.equal(path, archivedFile(id));
    assert.equal(statSync(SESSIONS_DIR).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes("sk-ant-abcdefghijklmnop"), raw);
    const record = archive.readArchivedSession(id);
    assert.equal(record.schema, "roundtable.session/1");
    assert.equal(record.topic, "Budget [redacted:env:ROUNDTABLE_ARCHIVE_TEST_TOKEN]");
    assert.equal(record.summary, "Agreed on [redacted:env:ROUNDTABLE_ARCHIVE_TEST_TOKEN]");
    assert.ok(record.transcript.startsWith("**cfo:** Key is [redacted:env:ROUNDTABLE_ARCHIVE_TEST_TOKEN] and "), record.transcript);
    assert.ok(record.transcript.endsWith("\n\n---\n\n**orchestrator:** focus"), record.transcript);
    assert.ok(record.turns[0].content.startsWith("Key is [redacted:env:ROUNDTABLE_ARCHIVE_TEST_TOKEN] and ") && !record.turns[0].content.includes("sk-ant-"));
    assert.deepEqual(record.agents, [ref, "skeptic"]);
    assert.equal(record.turns[0].agent, ref);
    const listed = archive.listArchivedSessions().find((s) => s.id === id);
    assert.deepEqual(listed, { id, kind: "collaboration", mode: "collaborate", agents: [ref, "skeptic"],
      topic: "Budget [redacted:env:ROUNDTABLE_ARCHIVE_TEST_TOKEN]",
      started: "2026-10-01T10:00:00.000Z", ended: "2026-10-01T11:00:00.000Z", public: false });
    assert.ok(!readdirSync(SESSIONS_DIR).some((n) => n.endsWith(".tmp")), "no temp files left behind");
  });

  test("ids that are not plain session ids are never used as file names", (t) => {
    const errors = t.mock.method(console, "error", () => {});
    for (const id of ["../escape", "a/b", "UPPER-1", "", ".hidden"]) {
      assert.equal(archive.archiveSession({ id, kind: "meeting", agents: [], topic: "", started: "x", turns: [], public: null }), null, id);
      assert.equal(archive.readArchivedSession(id), null, id);
    }
    assert.equal(errors.mock.callCount(), 5);
    assert.ok(!existsSync(join(SESSIONS_DIR, "..", "escape.json")));
    assert.equal(archive.readArchivedSession("meeting-neverwritten"), null);
  });

  test("end_meeting archives the history, summary and mode before the meeting leaves the map", async (t) => {
    scripted(t, "Opening reply", "Second reply", "The summary");
    const m = await startMeeting(sample, "Pricing agenda", "private context", "openai_compatible", "m", LLM, "debate");
    await continueMeeting(m.meetingId, "Push back");
    const ended = await handleToolCall("end_meeting", { meeting_id: m.meetingId, request_summary: true });
    assert.equal(ended.isError, undefined);
    const r = archive.readArchivedSession(m.meetingId);
    assert.equal(r.kind, "meeting");
    assert.equal(r.mode, "debate");
    assert.equal(r.topic, "Pricing agenda");
    assert.deepEqual(r.agents, [sample]);
    assert.equal(r.summary, "The summary");
    assert.deepEqual(r.turns.map((x) => x.role), ["caller", "agent", "caller", "agent"]);
    assert.equal(r.turns[1].agent, sample);
    assert.equal(r.turns[1].speaker, "sample");
    assert.equal(r.public, null);
    assert.ok(Date.parse(r.started) <= Date.parse(r.ended));
  });

  test("end_local_meeting archives with kind local-meeting", async () => {
    const id = "local-arch0001";
    localMeetings.set(id, {
      id, agent: "cfo", agenda: "Local agenda", agentPromptPath: sample, systemPrompt: "s", startedAt: new Date(),
      mode: "standard", messages: [{ role: "user", content: "Local agenda" }, { role: "assistant", content: "Local reply" }],
    });
    await endLocalMeeting(id);
    const r = archive.readArchivedSession(id);
    assert.equal(r.kind, "local-meeting");
    assert.equal(r.transcript, "**caller:** Local agenda\n\n---\n\n**cfo:** Local reply");
  });

  test("end_collaboration archives agent turns and nudges", async (t) => {
    scripted(t, "First", "Second", "Third");
    const c = await startCollaboration([sample, plain], "Launch plan", { ...opts, maxRounds: 2 });
    await nudgeCollaboration(c.collaborationId, "Consider the budget");
    await continueCollaboration(c.collaborationId, 1);
    await endCollaboration(c.collaborationId);
    const r = archive.readArchivedSession(c.collaborationId);
    assert.equal(r.kind, "collaboration");
    assert.equal(r.mode, "collaborate");
    assert.deepEqual(r.agents, [sample, plain]);
    assert.deepEqual(r.turns.map((x) => `${x.role}:${x.content}`),
      ["agent:First", "orchestrator:Consider the budget", "agent:Second", "agent:Third"]);
    assert.deepEqual(r.turns.map((x) => x.speaker), ["sample", "orchestrator", "plain", "sample"]);
    assert.equal(collaborations.has(c.collaborationId), false);
  });

  test("ultraplan finalize archives the document (versions, entries, sign-offs, tally) before ultraplans.delete", async (t) => {
    scripted(t, "Input A", "Verdict: APPROVE\nLooks right", "Sign-off: APPROVE\nShip it");
    const u = await startUltraplan([sample], "Launch the beta", opts);
    await submitPlan(u.ultraplanId, "1. Build [sample]");
    const realDelete = ultraplans.delete.bind(ultraplans);
    let archivedFirst = false;
    t.mock.method(ultraplans, "delete", (id) => {
      archivedFirst = existsSync(archivedFile(id));
      return realDelete(id);
    });
    const final = await submitPlan(u.ultraplanId, undefined, true);
    assert.equal(archivedFirst, true, "archived while still live");
    const r = archive.readArchivedSession(u.ultraplanId);
    assert.equal(r.kind, "ultraplan");
    assert.equal(r.mode, "orchestrator");
    assert.equal(r.summary, "signed off v1: 1 approve, 0 approve with reservations, 0 object");
    assert.equal(r.document.markdown, final.finalPlan);
    assert.equal(r.document.signedOff, true);
    assert.equal(r.document.version, 1);
    assert.equal(r.document.planner, "orchestrator");
    assert.deepEqual(r.document.versions.map((v) => [v.version, v.plan, v.author]), [[1, "1. Build [sample]", "orchestrator"]]);
    assert.deepEqual(r.document.entries.map((e) => e.phase), ["input", "plan", "review", "signoff"]);
    assert.equal(r.document.tally.APPROVE, 1);
    assert.equal(r.document.signoffs[0].verdict, "APPROVE");
    assert.deepEqual(r.turns.map((x) => x.speaker), ["sample · input", "orchestrator · plan v1", "sample · review of v1", "sample · sign-off"]);
  });

  test("end_ultraplan archives an unsigned document too", async (t) => {
    scripted(t, "Input A");
    const u = await startUltraplan([sample], "Unsigned", opts);
    await endUltraplan(u.ultraplanId);
    const r = archive.readArchivedSession(u.ultraplanId);
    assert.equal(r.document.signedOff, false);
    assert.equal(r.document.version, null);
    assert.equal(r.summary, "ended without a plan");
  });

  test("create_agent archives its result, and from_session falls back to an archived session", async (t) => {
    scripted(t, "Opening on launches", "Reply on launches");
    const c = await startCollaboration([sample, plain], "Launch checks", { ...opts, maxRounds: 1 });
    await continueCollaboration(c.collaborationId, 1);
    await endCollaboration(c.collaborationId);
    assert.equal(collaborations.has(c.collaborationId), false);

    const spec = JSON.stringify({
      name: "launch-owner", description: "Own launch checks", system_prompt: "You own launch readiness.",
      skills: [], contributions: [{ agent: "sample", summary: "Checks" }],
    });
    const calls = scripted(t, "Sample contribution", "Plain contribution", spec, "Verdict: READY", "Verdict: READY");
    const result = await createAgent({ ...opts, fromSession: c.collaborationId, write: false });
    const prompt = calls[0].body.messages.at(-1).content;
    assert.match(prompt, /## Discussion that led here/);
    assert.match(prompt, /\*\*sample:\*\* Opening on launches/);
    assert.match(prompt, /Launch checks/, "topic inherited from the archive");
    const r = archive.readArchivedSession(result.sessionId);
    assert.equal(r.kind, "agent-creation");
    assert.equal(r.topic, "Launch checks");
    assert.equal(r.result.agent.name, "launch-owner");
    assert.equal(r.result.publicBlock, undefined);
    assert.match(r.summary, /^preview: drafted launch-owner/);
    assert.deepEqual(r.turns.map((x) => x.phase), ["contribution", "contribution", "review", "review"]);
    assert.deepEqual(r.agents, [sample, plain], "participants are stored as the refs that were passed");
    assert.deepEqual(r.turns.map((x) => x.agent), [sample, plain, sample, plain]);
    await assert.rejects(createAgent({ ...opts, fromSession: "collab-nowhere1", write: false }),
      /from_session not found: collab-nowhere1\..*or of any archived session/);
  });

  test("a private prototype collaboration whose auto-run fails is archived before it is removed", async (t) => {
    let n = 0;
    stubFetch(t, () => (n++ === 0 ? reply("Opening turn") : json(500, { error: { message: "auto-run failed" } })));
    const topic = "Auto-run failure topic";
    await assert.rejects(
      startCollaboration([sample, plain], topic, { ...opts, maxRounds: 2, autoRun: true, runRounds: 1, prototype: true }),
      /auto-run failed/
    );
    const listed = archive.listArchivedSessions().filter((s) => s.topic === topic);
    assert.equal(listed.length, 1);
    assert.equal(collaborations.has(listed[0].id), false);
    const r = archive.readArchivedSession(listed[0].id);
    assert.match(r.summary, /^Auto-run stopped: .*auto-run failed/);
    assert.deepEqual(r.turns.map((x) => x.content), ["Opening turn"]);
  });

  test("from_session on a workshop archive reloads the participants' own files, not a same-key agent in AGENTS_DIR", async (t) => {
    const agentsDir = process.env.ROUNDTABLE_AGENTS_DIR;
    mkdirSync(agentsDir, { recursive: true });
    const impostor = join(agentsDir, "sample.md");
    writeFileSync(impostor, "---\nname: sample\ndescription: Not the fixture\n---\n\nIMPOSTOR-PROMPT-6612\n");
    t.after(() => rmSync(impostor, { force: true }));
    const spec = JSON.stringify({ name: "path-owner", description: "Owns paths", system_prompt: "You own paths.", skills: [] });
    scripted(t, "Sample idea", spec, "Verdict: READY");
    const first = await createAgent({ ...opts, agents: [sample], task: "Own paths", write: false });
    assert.deepEqual(archive.readArchivedSession(first.sessionId).agents, [sample]);

    const calls = scripted(t, "Again", spec, "Verdict: READY");
    await createAgent({ ...opts, fromSession: first.sessionId, write: false });
    const systems = calls.map((c) => c.body.messages[0].content);
    assert.ok(systems[0].includes("You are Sample."), systems[0]);
    assert.ok(systems.every((sys) => !sys.includes("IMPOSTOR-PROMPT-6612")), "the impostor's prompt reached the provider");
  });

  test("archiving is best effort: a broken sessions directory is logged and never fails the session", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const aside = `${SESSIONS_DIR}.aside`;
    const elsewhere = mkdtempSync(join(tmpdir(), "rt-archive-elsewhere-"));
    mkdirSync(SESSIONS_DIR, { recursive: true });
    renameSync(SESSIONS_DIR, aside);
    symlinkSync(elsewhere, SESSIONS_DIR);
    try {
      scripted(t, "Reply");
      const m = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", LLM);
      const ended = await endMeeting(m.meetingId);
      assert.match(ended, /ended/);
      assert.equal(meetings.has(m.meetingId), false);
      assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the symlink");
      assert.ok(errors.mock.calls.some((c) => /\[Archive\] Could not archive session meeting-/.test(String(c.arguments[0]))));
    } finally {
      rmSync(SESSIONS_DIR);
      renameSync(aside, SESSIONS_DIR);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
