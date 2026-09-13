import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { startMeeting, continueMeeting, endMeeting, listMeetings } = await import("../../dist/sessions/meetings.js");
const { startCollaboration, endCollaboration, listCollaborations } = await import(
  "../../dist/sessions/collaborations.js"
);

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../fixtures/agents/sample.md");
const plain = resolve(here, "../fixtures/agents/plain.md");
const BASE = "http://localhost:1234/v1";
const ENDPOINT = `${BASE}/chat/completions`;
const reply = (i) => json(200, { choices: [{ message: { content: `reply ${i}` } }] });

describe("meetings carry base_url for their whole life", () => {
  test("start, say, list, end(summary) all hit the configured base", async (t) => {
    const calls = stubFetch(t, (_url, _init, i) => reply(i));
    const { meetingId, response } = await startMeeting(sample, "agenda", "ctx", "openai_compatible", "m", BASE);
    assert.equal(response, "reply 0");
    assert.equal(calls[0].url, ENDPOINT);
    assert.ok(!("Authorization" in calls[0].init.headers));
    const system = calls[0].body.messages[0];
    assert.equal(system.role, "system");
    assert.ok(!system.content.startsWith("---"), `frontmatter leaked: ${system.content.slice(0, 40)}`);
    assert.equal(system.content, "You are Sample.\n");
    assert.equal(calls[0].body.messages[1].content, "agenda\n\n---\n\nctx");
    assert.equal(calls[0].body.model, "m");

    const second = await continueMeeting(meetingId, "more");
    assert.equal(second, "reply 1");
    assert.equal(calls[1].url, ENDPOINT);
    assert.equal(calls[1].body.messages.length, 4);

    const listed = listMeetings().find((m) => m.id === meetingId);
    assert.equal(listed.baseUrl, BASE);
    assert.equal(listed.provider, "openai_compatible");
    assert.equal(listed.messageCount, 4);

    const summary = await endMeeting(meetingId, true);
    assert.equal(summary, "reply 2");
    assert.equal(calls[2].url, ENDPOINT);
    assert.equal(calls.length, 3);
    assert.ok(!listMeetings().some((m) => m.id === meetingId));
  });

  test("listMeetings omits baseUrl when none was given", async (t) => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "http://env-host:9999/v1";
    t.after(() => delete process.env.OPENAI_COMPATIBLE_BASE_URL);
    const calls = stubFetch(t, (_url, _init, i) => reply(i));
    const { meetingId } = await startMeeting(plain, "agenda", undefined, "openai_compatible", "m");
    assert.equal(calls[0].url, "http://env-host:9999/v1/chat/completions");
    const listed = listMeetings().find((m) => m.id === meetingId);
    assert.ok(!("baseUrl" in listed));
    await endMeeting(meetingId);
  });
});

describe("collaborations carry base_url for their whole life", () => {
  test("opening call, auto-run rounds and the summary all hit the configured base", async (t) => {
    const calls = stubFetch(t, (_url, _init, i) => reply(i));
    const { collaborationId, messages, status } = await startCollaboration([sample, plain], "topic", {
      provider: "openai_compatible",
      model: "m",
      baseUrl: BASE,
      autoRun: true,
      runRounds: 1,
    });
    assert.equal(status, "running");
    // opening call + one full round (2 agents) = 3 messages
    assert.equal(messages.length, 3);
    assert.equal(calls.length, 3);
    for (const c of calls) assert.equal(c.url, ENDPOINT);
    // turn order: Sample opens, then Plain and Sample each take one turn in the auto-run round
    assert.equal(calls[0].body.messages[0].content, "You are Sample.\n");
    assert.equal(calls[1].body.messages[0].content, "You are Plain. No frontmatter here.\n");
    assert.equal(calls[2].body.messages[0].content, "You are Sample.\n");
    assert.deepEqual(messages.map((m) => m.agent), [sample, plain, sample]);

    const listed = listCollaborations().find((c) => c.id === collaborationId);
    assert.equal(listed.baseUrl, BASE);

    const { transcript, summary } = await endCollaboration(collaborationId, true);
    assert.equal(transcript.length, 3);
    assert.equal(summary, "reply 3");
    assert.equal(calls[3].url, ENDPOINT);
    assert.equal(calls.length, 4);
  });
});
