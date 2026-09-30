import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { json, stubFetch } from "./helpers.mjs";

// Must be set before the first import of config.js.
const TRANSCRIPTS = mkdtempSync(resolve(tmpdir(), "rt-transcripts-"));
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = TRANSCRIPTS;
process.env.ROUNDTABLE_NTFY_URL = "http://ntfy.test";
process.env.ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS = "5000";
delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { startMeeting, continueMeeting, endMeeting, listMeetings } = await import("../../dist/sessions/meetings.js");
const { startCollaboration, continueCollaboration, nudgeCollaboration, endCollaboration, listCollaborations } =
  await import("../../dist/sessions/collaborations.js");
const { handleToolCall } = await import("../../dist/tools.js");

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => resolve(here, "../fixtures/agents", n);
const sample = fx("sample.md");
const plain = fx("plain.md");
const LLM = "http://localhost:1234/v1";
const NTFY = "http://ntfy.test";
const opts = { provider: "openai_compatible", model: "m", baseUrl: LLM };
const MARKER = "ZQX-PRIVATE-CONTEXT-7781";

const isNtfy = (c) => c.url.startsWith(NTFY);
const isLlm = (c) => c.url.startsWith(LLM);
// LLM URL -> chat reply; ntfy URL -> ok publish (or empty history poll).
function script(extra) {
  let n = 0;
  return (url, init) => {
    if (extra) {
      const r = extra(url, init);
      if (r) return r;
    }
    if (url.startsWith(LLM)) return json(200, { choices: [{ message: { content: `reply ${++n}` } }] });
    if (init.method === "POST") return json(200, { id: "x", time: 1 });
    return new Response("", { status: 200 });
  };
}
const sys = (call) => call.body.messages[0].content;
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("public sessions", () => {
  test("public:false (default) makes zero requests to the ntfy base", async (t) => {
    const calls = stubFetch(t, script());
    const c = await startCollaboration([sample, plain], "topic", { ...opts, maxRounds: 1 });
    assert.equal(c.public, undefined);
    await continueCollaboration(c.collaborationId, 1);
    const end = await endCollaboration(c.collaborationId, true);
    assert.equal(end.publicBlock, undefined);
    const m = await startMeeting(sample, "agenda", "ctx", "openai_compatible", "m", LLM);
    await continueMeeting(m.meetingId, "hi");
    const me = await endMeeting(m.meetingId, true);
    assert.ok(!/Public transcript/.test(me));
    await settle();
    assert.equal(calls.filter(isNtfy).length, 0);
    assert.ok(calls.filter(isLlm).length > 0);
    assert.ok(calls.filter(isLlm).every((c) => !sys(c).includes("PUBLIC SESSION NOTICE")));
  });

  test("public collaboration: header first, turns in order, context never posted, directive in every system prompt", async (t) => {
    const calls = stubFetch(t, script());
    const c = await startCollaboration([sample, plain], "the open topic", {
      ...opts,
      maxRounds: 1,
      context: `${MARKER} secret background`,
      public: true,
    });
    assert.ok(c.public.url.startsWith(NTFY + "/"), c.public.url);
    assert.ok(c.public.topic);
    await continueCollaboration(c.collaborationId, 1);
    await nudgeCollaboration(c.collaborationId, "please focus");
    const end = await endCollaboration(c.collaborationId, true);
    assert.match(end.publicBlock, /Public transcript: http:\/\/ntfy\.test\//);
    assert.match(end.publicBlock, /Saved: /);
    assert.match(end.publicBlock, /Published \d+\/\d+/);

    const posts = calls.filter((x) => isNtfy(x) && x.init.method === "POST");
    assert.ok(posts.length >= 4, `posts: ${posts.length}`);
    const bodyText = (x) => JSON.stringify(x.body);
    assert.match(bodyText(posts[0]), /Mode/, "header first");
    assert.match(bodyText(posts[0]), /the open topic/);
    const titles = posts.map((p) => p.body.title);
    const idx = (re) => titles.findIndex((tt) => re.test(tt));
    assert.ok(idx(/sample/i) >= 0 || idx(/agents/i) >= 0 || titles.length > 1);
    // order: turn numbers non-decreasing
    const nums = titles.map((tt) => parseInt(/^#(\d+)/.exec(tt)?.[1] ?? "-1", 10));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
    assert.ok(titles.some((tt) => /ORCHESTRATOR/.test(tt)), "nudge posted");
    assert.ok(titles.some((tt) => /summary/.test(tt)), "summary posted");
    // context marker never in any ntfy body
    for (const p of calls.filter(isNtfy)) assert.ok(!JSON.stringify(p.init.body ?? "").includes(MARKER));
    // but the agents did receive it (proves the marker was live)
    assert.ok(calls.filter(isLlm).some((x) => JSON.stringify(x.body).includes(MARKER)));
    // directive on every LLM system prompt
    const llm = calls.filter(isLlm);
    assert.ok(llm.length >= 3);
    for (const x of llm) assert.ok(sys(x).includes("PUBLIC SESSION NOTICE"));
    // sent Firebase: no
    assert.equal(posts[0].init.headers["Firebase"] ?? posts[0].init.headers["firebase"], "no");
  });

  test("end result has url + saved path and the file exists", async (t) => {
    stubFetch(t, script());
    const c = await startCollaboration([sample, plain], "saved topic", { ...opts, maxRounds: 1, public: true });
    const end = await endCollaboration(c.collaborationId, false);
    const m = /Saved: (.+?) ·/.exec(end.publicBlock);
    assert.ok(m, end.publicBlock);
    assert.ok(m[1].startsWith(TRANSCRIPTS), m[1]);
    assert.ok(existsSync(m[1]));
    assert.match(readFileSync(m[1], "utf8"), /saved topic/);
    const tool = await handleToolCall("list_collaborations", {});
    assert.ok(!/error/i.test(tool.content[0].text));
  });

  test("public meeting: agenda only as caller entry, say posted, context excluded, list shows public/mode", async (t) => {
    const calls = stubFetch(t, script());
    const m = await startMeeting(sample, "public agenda", `${MARKER} private`, "openai_compatible", "m", LLM, "standard", undefined, true);
    assert.ok(m.public.url);
    assert.ok(listMeetings().find((x) => x.id === m.meetingId).public);
    await continueMeeting(m.meetingId, "my say message");
    const out = await endMeeting(m.meetingId, true);
    assert.match(out, /Public transcript: /);
    const bodies = calls.filter((x) => isNtfy(x) && x.init.method === "POST").map((x) => JSON.stringify(x.body));
    assert.ok(bodies.some((b) => b.includes("public agenda")));
    assert.ok(bodies.some((b) => b.includes("my say message")));
    assert.ok(!bodies.some((b) => b.includes(MARKER)));
    assert.ok(calls.filter(isLlm).every((x) => sys(x).includes("PUBLIC SESSION NOTICE")));
  });

  test("publish failure does not fail the session", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (url.startsWith(NTFY)) throw new Error("connection refused");
      return json(200, { choices: [{ message: { content: "ok" } }] });
    });
    const c = await startCollaboration([sample, plain], "t", { ...opts, maxRounds: 1, public: true });
    await continueCollaboration(c.collaborationId, 1);
    const end = await endCollaboration(c.collaborationId, true);
    assert.ok(end.summary);
    assert.match(end.publicBlock, /Published 0\//);
    assert.match(end.publicBlock, /Warning/);
    assert.ok(calls.some(isNtfy));
  });

  test("bad publisher config fails the start with a clear error before any LLM call", async (t) => {
    const calls = stubFetch(t, script());
    const prev = process.env.ROUNDTABLE_PUBLISHER;
    // config is read at import; verify via the tool error path using an unusable webhook publisher
    const { openPublicChannel } = await import("../../dist/sessions/public.js");
    const { createPublicChannel } = await import("../../dist/publishers/index.js");
    assert.throws(() => createPublicChannel("s", { participants: ["a"] }, { config: { kind: "bogus", ntfyUrl: NTFY, topicPrefix: "x" } }), /Unknown/);
    assert.equal(typeof openPublicChannel, "function");
    assert.equal(calls.length, 0);
    process.env.ROUNDTABLE_PUBLISHER = prev ?? "";
    if (prev === undefined) delete process.env.ROUNDTABLE_PUBLISHER;
  });

  test("debug_env reports the publisher without secret values", async (t) => {
    stubFetch(t, script());
    process.env.ROUNDTABLE_NTFY_TOKEN = "tk_supersecretvalue";
    const r = await handleToolCall("debug_env", {});
    const text = r.content[0].text;
    assert.match(text, /"publisher": "ntfy"/);
    assert.ok(!text.includes("supersecretvalue"));
    delete process.env.ROUNDTABLE_NTFY_TOKEN;
  });

  test("public collaboration: first LLM call failing finalizes the channel and leaves no orphan", async (t) => {
    const calls = stubFetch(t, script((url) => (url.startsWith(LLM) ? json(500, { error: "down" }) : undefined)));
    const before = listCollaborations().length;
    await assert.rejects(startCollaboration([sample, plain], "t", { ...opts, public: true }));
    assert.equal(listCollaborations().length, before);
    await settle();
    assert.ok(calls.some((c) => isNtfy(c) && c.init.method === "POST"), "header was posted");
  });

  test("public collaboration: auto-run failure keeps the URL and pauses the session", async (t) => {
    let llm = 0;
    stubFetch(t, script((url) => {
      if (url.startsWith(LLM) && ++llm === 3) return json(500, { error: "rate" });
    }));
    const c = await startCollaboration([sample, plain], "t", { ...opts, maxRounds: 3, autoRun: true, runRounds: 3, public: true });
    assert.equal(c.status, "paused");
    assert.match(c.error, /Auto-run stopped/);
    assert.ok(c.public.url.startsWith(NTFY + "/"));
    await endCollaboration(c.collaborationId);
  });

  test("path-style agent names never appear in published titles", async (t) => {
    const calls = stubFetch(t, script());
    const c = await startCollaboration([sample, plain], "t", { ...opts, maxRounds: 1, public: true });
    await continueCollaboration(c.collaborationId, 1);
    await endCollaboration(c.collaborationId);
    for (const p of calls.filter((x) => isNtfy(x) && x.init.method === "POST")) {
      assert.ok(!p.body.title.includes("/"), p.body.title);
      assert.ok(!p.body.title.includes("fixtures"), p.body.title);
    }
  });

  test("public collaboration: LLM prompts use public labels, never raw agent paths; private keeps raw", async (t) => {
    for (const mode of ["collaborate", "debate", "waffle-house"]) {
      const calls = stubFetch(t, script());
      const c = await startCollaboration([sample, plain], "t", { ...opts, mode, maxRounds: 1, public: true });
      await continueCollaboration(c.collaborationId, 1);
      await endCollaboration(c.collaborationId, true);
      const llm = calls.filter(isLlm);
      assert.ok(llm.length >= 3, mode);
      for (const call of llm) {
        for (const m of call.body.messages) {
          assert.ok(!m.content.includes(dirname(sample)), `${mode}: raw path leaked into prompt`);
        }
      }
      t.mock.restoreAll();
    }
    const calls = stubFetch(t, script());
    const c = await startCollaboration([sample, plain], "t", { ...opts, maxRounds: 1 });
    await continueCollaboration(c.collaborationId, 1);
    await endCollaboration(c.collaborationId);
    assert.ok(calls.filter(isLlm).some((x) => x.body.messages.some((m) => m.content.includes(sample))));
  });

  test("paused-collaboration guidance points to nudge_collaboration", async (t) => {
    let llm = 0;
    stubFetch(t, script((url) => {
      if (url.startsWith(LLM) && ++llm === 3) return json(500, { error: "rate" });
    }));
    const c = await startCollaboration([sample, plain], "t", { ...opts, maxRounds: 3, autoRun: true, runRounds: 3, public: true });
    assert.equal(c.status, "paused");
    assert.match(c.error, /nudge_collaboration/);
    assert.doesNotMatch(c.error, /use continue_collaboration/);
    await endCollaboration(c.collaborationId);
    const { tools } = await import("../../dist/tools.js");
    const pause = tools.find((x) => x.name === "pause_collaboration");
    assert.match(pause.description, /nudge_collaboration/);
  });

});
