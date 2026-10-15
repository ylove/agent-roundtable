import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { startMeeting, continueMeeting, endMeeting, meetings } = await import("../../dist/sessions/meetings.js");
const { continueLocalMeeting, endLocalMeeting } = await import("../../dist/sessions/local-meetings.js");
const { startCollaboration, continueCollaboration, endCollaboration, collaborations, MAX_COLLABORATION_ROUNDS } =
  await import("../../dist/sessions/collaborations.js");
const { startUltraplan, endUltraplan, listUltraplans } = await import("../../dist/sessions/ultraplan.js");
const { SessionBusyError, isSessionBusy, lockSession, sessionBusyMessage, withSessionLock } = await import("../../dist/sessions/lock.js");
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
