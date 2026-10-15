// Prototype mode wired into collaborations, API meetings and local meetings (offline: every provider
// reply is scripted; the board is a real 127.0.0.1 server). test-env.mjs points ROUNDTABLE_PROTOTYPE_DIR
// at a temp dir, never opens a browser and turns screenshots off.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { json, stubFetch } from "./helpers.mjs";

// Must be set before the first import of config.js.
process.env.ROUNDTABLE_NTFY_URL = "http://ntfy.test";
process.env.ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS = "5000";
delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.ROUNDTABLE_PROTOTYPE_OPEN;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
assert.ok(process.env.ROUNDTABLE_PROTOTYPE_DIR, "test-env.mjs must set ROUNDTABLE_PROTOTYPE_DIR");
const PROTO_ROOT = process.env.ROUNDTABLE_PROTOTYPE_DIR;

const {
  startCollaboration,
  continueCollaboration,
  advanceCollaboration,
  nudgeCollaboration,
  pauseCollaboration,
  endCollaboration,
  listCollaborations,
  getCollaborationTranscript,
  collaborations,
} = await import("../../dist/sessions/collaborations.js");
const { startMeeting, continueMeeting, endMeeting, listMeetings, meetings } = await import("../../dist/sessions/meetings.js");
const { listLocalMeetings, localMeetings } = await import("../../dist/sessions/local-meetings.js");
const { createAgent } = await import("../../dist/sessions/agent-creation.js");
const { serializeTurn } = await import("../../dist/sessions/prototype-mode.js");
const { handleToolCall, tools } = await import("../../dist/tools.js");
const { deliberationTools } = await import("../../dist/tools/deliberation.js");
const prototypes = await import("../../dist/prototypes/index.js");
const { PublicChannel, publicLabel } = await import("../../dist/publishers/index.js");

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => resolve(here, "../fixtures/agents", n);
const A = fx("sample.md"); // "You are Sample.\n"
const B = fx("plain.md"); // "You are Plain. No frontmatter here.\n"
const C = fx("third.md"); // "You are Third.\n"
const LLM = "http://localhost:4141/v1";
const NTFY = "http://ntfy.test";
const opts = { provider: "openai_compatible", model: "m", baseUrl: LLM };
const MARK = "COUPON-MARK-4117";

const webBlock = (revises) =>
  `I propose an inline coupon field on the checkout page.\n\n` +
  `<prototype title="Inline coupon field" kind="web" entry="index.html"${revises ? ` revises="${revises}"` : ""}>\n` +
  `<file path="index.html"><!doctype html><html><body><h1>Checkout</h1><input id="coupon" placeholder="${MARK}"></body></html></file>\n` +
  `<demo>Impatient user: pastes a code and sees instant validation. Impaired user: one large field, no tiny buttons. ` +
  `Expert: tabs straight into the field from the keyboard.</demo>\n` +
  `</prototype>`;

const isLlm = (c) => c.url.startsWith(LLM);
const isNtfy = (c) => c.url.startsWith(NTFY);
const sys = (call) => call.body.messages[0].content;
const lastUser = (call) => call.body.messages.at(-1).content;
/** The board URL is http://127.0.0.1:<port>/ optionally followed by a capability path; tests only use returned URLs. */
const BOARD_URL = /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/$/; // capability token path is required
const FINAL_ROUND = "This is the final round: do not start a new prototype";
const OWNERSHIP = "Only a prototype's proposer decides on it";
const llmReply = (content) => json(200, { choices: [{ message: { content } }] });

/** LLM calls get the scripted replies in order ("ok" once they run out); ntfy accepts everything. */
function script(replies, extra) {
  let n = 0;
  return (url, init) => {
    const r = extra?.(url, init);
    if (r) return r;
    if (url.startsWith(LLM)) return llmReply(replies[n++] ?? "ok");
    if (url.startsWith(NTFY)) return init.method === "GET" ? new Response("", { status: 200 }) : json(200, { id: "x", time: 1 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

/** Plain GET against the local board (never through the stubbed fetch). */
function httpGet(url) {
  return new Promise((res) => {
    const req = request(url, { method: "GET", agent: false }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (d) => (body += d));
      r.on("end", () => res({ status: r.statusCode, body }));
    });
    req.on("error", (e) => res({ status: 0, error: e.code }));
    req.end();
  });
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
/** Materialized copies of the scripted prototype anywhere under the sandbox root. */
const liveCopies = () => filesUnder(PROTO_ROOT).filter((f) => f.endsWith("index.html") && readFileSync(f, "utf8").includes(MARK));
const sessionDirs = () => (existsSync(PROTO_ROOT) ? readdirSync(PROTO_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0);

after(() => prototypes.destroyAllPrototypes("shutdown"));

describe("schemas", () => {
  test("the three start tools expose a boolean prototype flag; tool count unchanged", () => {
    assert.equal(deliberationTools.length, 22, "prototype mode adds no tool");
    for (const name of ["start_meeting", "start_local_meeting", "start_collaboration"]) {
      const p = tools.find((x) => x.name === name).inputSchema.properties.prototype;
      assert.equal(p?.type, "boolean", name);
      assert.match(p.description, /board URL/);
      assert.match(p.description, /Not supported with mode conversation/);
    }
  });

  test("a non-boolean prototype is rejected before any provider call", async (t) => {
    const calls = stubFetch(t, script([]));
    for (const [name, args] of [
      ["start_meeting", { agent: A, agenda: "a", prototype: "yes" }],
      ["start_local_meeting", { agent: A, agenda: "a", prototype: 1 }],
      ["start_collaboration", { agents: [A, B], topic: "t", prototype: "true" }],
    ]) {
      const r = await handleToolCall(name, args);
      assert.equal(r.isError, true, name);
      assert.equal(r.content[0].text, `Error: ${name}: "prototype" must be a boolean`);
    }
    assert.equal(calls.length, 0);
  });
});

describe("collaboration prototype flow", () => {
  test("2 agents: propose, board serves, verdict destroys, decision prompt, shortlist, stubbed transcript", async (t) => {
    const calls = stubFetch(t, script([
      webBlock(),
      "Looks usable.\nVerdict on P1: APPROVE — small and clear",
      "Decision on P1: SHORTLIST — approved by Plain",
      "Agreed, ship it.",
    ]));
    const before = sessionDirs();
    const r = await startCollaboration([A, B], "checkout coupons", { ...opts, maxRounds: 2, prototype: true });
    const id = r.collaborationId;

    // The directive is on every system prompt; the start result carries the board and the live item.
    assert.ok(sys(calls[0]).startsWith("You are Sample.\n"));
    assert.ok(sys(calls[0]).includes("## Prototype mode"));
    assert.match(r.prototypes.board_url, BOARD_URL);
    assert.equal(r.prototypes.live.length, 1);
    assert.equal(r.prototypes.live[0].label, "P1 v1");
    assert.equal(r.prototypes.live[0].kind, "web");
    assert.deepEqual(r.prototypes.live[0].awaiting_verdicts_from, [B]);
    assert.match(r.prototypes.notice, /board URL/);
    assert.equal(sessionDirs(), before + 1);

    // Live: board and viewer serve, the sandbox holds the file, list shows the board, nudges are held.
    assert.equal((await httpGet(r.prototypes.board_url)).status, 200);
    const viewer = r.prototypes.live[0].url;
    assert.ok(viewer.startsWith(r.prototypes.board_url));
    assert.equal((await httpGet(viewer)).status, 200);
    assert.equal(liveCopies().length, 1);
    const row = listCollaborations().find((c) => c.id === id);
    assert.equal(row.prototype, true);
    assert.equal(row.board_url, r.prototypes.board_url);
    await assert.rejects(nudgeCollaboration(id, "the human likes it"), /nudges are held/);
    assert.equal(collaborations.get(id).messages.length, 1, "a refused nudge records nothing");

    // Plain assesses: its prompt shows the full source and asks for a verdict; then the artifact is gone.
    const collab = collaborations.get(id);
    await advanceCollaboration(collab);
    const assessorPrompt = lastUser(calls[1]);
    assert.ok(assessorPrompt.includes(`<input id="coupon" placeholder="${MARK}">`), "live source shown in full");
    assert.ok(assessorPrompt.includes("## Prototype status"));
    assert.ok(assessorPrompt.includes("Verdict on P1: APPROVE|REVISE|REJECT"));
    // the status section sits before the closing instruction
    assert.ok(assessorPrompt.indexOf("## Prototype status") < assessorPrompt.indexOf("---\n\nIt's your turn to respond."));
    assert.equal(liveCopies().length, 0, "sandbox removed after assessment");
    assert.equal((await httpGet(viewer)).status, 410);
    assert.equal((await httpGet(r.prototypes.board_url)).status, 200, "board stays up until the session ends");

    // Nudges are allowed again once nothing is under assessment.
    await nudgeCollaboration(id, "keep it short");

    // Sample is asked to decide, with Plain's verdict and reason.
    const mid = await continueCollaboration(id, 1);
    const decisionPrompt = lastUser(calls[2]);
    assert.ok(decisionPrompt.includes("has been assessed and destroyed"));
    assert.ok(decisionPrompt.includes("APPROVE — small and clear"));
    assert.ok(decisionPrompt.includes("Decision on P1: REVISE|SCRAP|SHORTLIST"));
    // Final turn (Plain): the shortlisted prototype is a stub, and the final-round line appears.
    const finalPrompt = lastUser(calls[3]);
    assert.ok(finalPrompt.includes('[Prototype P1 v1 "Inline coupon field" (web, 1 file)'), finalPrompt);
    assert.ok(!finalPrompt.includes(MARK), "resolved source never re-sent");
    assert.ok(finalPrompt.includes(FINAL_ROUND));
    assert.equal(mid.status, "completed");
    assert.deepEqual(mid.prototypes.destroyed_this_call, ["P1 v1"]);
    assert.equal(mid.prototypes.live.length, 0);

    // Completion closed the board.
    assert.equal(collab.prototype.closed, true);
    assert.equal((await httpGet(r.prototypes.board_url)).status, 0);
    assert.ok(!("board_url" in listCollaborations().find((c) => c.id === id)));
    assert.equal(sessionDirs(), before, "session directory removed");

    // Transcript (mid-session view) is stubbed too.
    const transcript = getCollaborationTranscript(id);
    assert.ok(transcript[0].content.startsWith("I propose an inline coupon field"));
    assert.ok(!transcript[0].content.includes(MARK));

    const end = await handleToolCall("end_collaboration", { collaboration_id: id });
    const text = end.content[0].text;
    const [transcriptPart, outcomesPart] = text.split("## Prototype outcomes");
    assert.ok(outcomesPart, text);
    assert.ok(!transcriptPart.includes(MARK), "transcript shows stubs only");
    assert.ok(transcriptPart.includes("[Prototype P1 v1"));
    assert.ok(outcomesPart.includes("## Shortlist for the human"));
    assert.ok(outcomesPart.includes(MARK), "shortlist carries the full source");
    assert.ok(outcomesPart.includes("SHORTLIST"));
    assert.match(text, /the human may now give feedback/);
  });

  for (const mode of ["collaborate", "waffle-house"]) {
    test(`3 agents (${mode}): destroyed only after every other agent has assessed`, async (t) => {
      const calls = stubFetch(t, script([
        webBlock(),
        "Verdict on P1: REJECT — the field hides the total",
        "Verdict on P1: APPROVE — fine for a first cut",
        "Decision on P1: SCRAP — the rejection is right",
      ]));
      const r = await startCollaboration([A, B, C], "checkout coupons", { ...opts, mode, maxRounds: 2, prototype: true });
      const id = r.collaborationId;
      assert.equal(r.prototypes.live[0].awaiting_verdicts_from.length, 2);
      const viewer = r.prototypes.live[0].url;

      const afterB = await continueCollaboration(id, 0); // no-op: still running, summary only
      assert.equal(afterB.newMessages.length, 0);
      await advanceCollaboration(collaborations.get(id)); // B
      assert.equal(liveCopies().length, 1, "still live: C has not assessed");
      assert.equal((await httpGet(viewer)).status, 200);
      await assert.rejects(nudgeCollaboration(id, "x"), /nudges are held/);

      // A paused session with a live prototype resumes on continue (nudges, the usual way, are held).
      pauseCollaboration(id);
      const resumed = await continueCollaboration(id, 1);
      assert.ok(resumed.newMessages.length >= 2);
      assert.equal(liveCopies().length, 0, "destroyed after C");
      assert.equal((await httpGet(viewer)).status, 410);
      const decision = lastUser(calls[3]);
      assert.ok(decision.includes("REJECT — the field hides the total") && decision.includes("APPROVE — fine for a first cut"));
      assert.deepEqual(resumed.prototypes.destroyed_this_call, ["P1 v1"]);
      if (mode === "waffle-house") assert.ok(decision.includes('End with "Current position (v2):"'), "defender prompt intact");

      const { transcript, prototypeOutcomes } = await endCollaboration(id);
      assert.ok(transcript.every((m) => !m.content.includes(MARK)));
      assert.match(prototypeOutcomes, /P1 v1/);
      assert.match(prototypeOutcomes, /SCRAP/);
      assert.match(prototypeOutcomes, /None of the prototypes were shortlisted/);
    });
  }

  test("conversation + prototype is rejected before any provider call or sandbox", async (t) => {
    const calls = stubFetch(t, script([]));
    const before = sessionDirs();
    await assert.rejects(
      startCollaboration([A, B], undefined, { ...opts, mode: "conversation", prototype: true }),
      /not supported with mode "conversation"/
    );
    const r = await handleToolCall("start_collaboration", {
      agents: [A, B], mode: "conversation", prototype: true, provider: "openai_compatible", model: "m", base_url: LLM,
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not supported with mode "conversation"/);
    assert.equal(calls.length, 0);
    assert.equal(sessionDirs(), before);
    assert.equal(prototypes.activePrototypeTrackers().length, 0);
  });

  test("first LLM call failing closes the board and removes the session directory", async (t) => {
    stubFetch(t, () => json(500, { error: "down" }));
    const before = sessionDirs();
    const rows = listCollaborations().length;
    await assert.rejects(startCollaboration([A, B], "t", { ...opts, prototype: true }));
    assert.equal(listCollaborations().length, rows);
    assert.equal(prototypes.activePrototypeTrackers().length, 0);
    assert.equal(sessionDirs(), before);
  });

  test("end_collaboration on a live prototype destroys it and lists it as closed", async (t) => {
    stubFetch(t, script([webBlock()]));
    const r = await startCollaboration([A, B], "t", { ...opts, prototype: true });
    assert.equal(liveCopies().length, 1);
    const viewer = r.prototypes.live[0].url;
    const out = (await handleToolCall("end_collaboration", { collaboration_id: r.collaborationId })).content[0].text;
    assert.equal(liveCopies().length, 0);
    assert.equal((await httpGet(viewer)).status, 0);
    assert.match(out, /closed at session end/);
    assert.ok(!out.split("## Prototype outcomes")[0].includes(MARK));
  });
});

describe("API meeting: the caller assesses", () => {
  test("say with a verdict destroys, the agent revises, say output carries the Prototypes block", async (t) => {
    const calls = stubFetch(t, script([
      webBlock(),
      `Decision on P1: REVISE — wider field\n\n${webBlock("P1")}`,
      "Decision on P1: SHORTLIST — approved",
      "Thanks.",
    ]));
    const start = JSON.parse((await handleToolCall("start_meeting", {
      agent: A, agenda: "checkout coupons", provider: "openai_compatible", model: "m", base_url: LLM, prototype: true,
    })).content[0].text);
    const id = start.meetingId;
    assert.ok(sys(calls[0]).includes("## Prototype mode"));
    assert.equal(start.prototypes.live.length, 1);
    assert.deepEqual(start.prototypes.live[0].awaiting_verdicts_from, ["caller"]);
    const v1 = start.prototypes.live[0].url;
    assert.equal((await httpGet(v1)).status, 200);
    const row = listMeetings().find((m) => m.id === id);
    assert.equal(row.prototype, true);
    assert.equal(row.board_url, start.prototypes.board_url);

    const say1 = (await handleToolCall("say", { meeting_id: id, message: "Verdict on P1: REVISE — make the field wider" })).content[0].text;
    assert.equal((await httpGet(v1)).status, 410, "the caller's verdict destroyed v1");
    // The agent saw the verdict and the decision request after the caller's words.
    const toAgent = lastUser(calls[1]);
    assert.ok(toAgent.startsWith("Verdict on P1: REVISE — make the field wider\n\n## Prototype status"));
    assert.ok(toAgent.includes("Decide now"));
    assert.ok(calls[1].body.messages[2].content.includes(MARK), "awaiting decision: source still shown");
    const [reply, trailer] = say1.split("\n\n---\nPrototypes: ");
    assert.ok(reply.startsWith("Decision on P1: REVISE"));
    const summary = JSON.parse(trailer);
    assert.deepEqual(summary.destroyed_this_call, ["P1 v1"]);
    assert.equal(summary.live[0].label, "P1 v2");
    assert.equal(summary.board_url, start.prototypes.board_url);

    const say2 = (await handleToolCall("say", { meeting_id: id, message: "Verdict on P1: APPROVE — good" })).content[0].text;
    assert.ok(say2.includes("\n\n---\nPrototypes: "));
    // v1 is now a stub in the history the agent sees; v2 (awaiting decision) is in full.
    assert.ok(calls[2].body.messages[2].content.includes("[Prototype P1 v1"));
    assert.ok(!calls[2].body.messages[2].content.includes(MARK));
    assert.ok(calls[2].body.messages[4].content.includes(MARK));

    const end = (await handleToolCall("end_meeting", { meeting_id: id })).content[0].text;
    assert.ok(end.startsWith(`Meeting ${id} with ${A} ended.\n\n## Prototype outcomes`));
    assert.match(end, /\*\*P1 v1\*\*.*REVISE/);
    assert.match(end, /### P1 v2/);
    assert.ok(end.includes(MARK));
    assert.equal(prototypes.activePrototypeTrackers().length, 0);
    assert.equal(liveCopies().length, 0);
  });

  test("end_meeting with a summary closes first and sends only stubs to the summarizer", async (t) => {
    const calls = stubFetch(t, script([webBlock(), "Summary text"]));
    const m = await startMeeting(A, "agenda", undefined, "openai_compatible", "m", LLM, "standard", undefined, false, true);
    const out = await endMeeting(m.meetingId, true);
    assert.ok(out.startsWith("Summary text\n\n## Prototype outcomes"));
    const summaryCall = calls.at(-1);
    assert.ok(summaryCall.body.messages.every((x) => !x.content.includes(MARK)));
    assert.ok(summaryCall.body.messages[2].content.includes("[Prototype P1 v1"));
  });
});

describe("local meeting (fake claude on PATH)", () => {
  test("directive via --append-system-prompt, verdict reaches the CLI prompt, stubs in history, outcomes at end", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-proto-"));
    const log = join(dir, "runs.jsonl");
    const replies = join(dir, "replies.json");
    writeFileSync(replies, JSON.stringify([webBlock(), "Decision on P1: SHORTLIST — approved", "Noted."]));
    const bin = join(dir, "claude");
    // Records { argv, stdin } per call: the prompt arrives on stdin, never as an argument.
    writeFileSync(
      bin,
      `#!${process.execPath}\nif (process.argv.includes("--help")) { process.stdout.write("--permission-prompts\\n"); process.exit(0); }\nconst fs = require("node:fs");\nlet input = "";\n` +
        `process.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (d) => (input += d));\nprocess.stdin.on("end", () => {\n` +
        `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + "\\n");\n` +
        `  const n = fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length - 1;\n` +
        `  const r = JSON.parse(fs.readFileSync(${JSON.stringify(replies)}, "utf8"));\n` +
        `  process.stdout.write(r[Math.min(n, r.length - 1)]);\n});\n`
    );
    chmodSync(bin, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    t.after(() => {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    });
    const runs = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const argvs = () => runs().map((r) => r.argv);
    const prompts = () => runs().map((r) => r.stdin);
    const appendOf = (a) => a[a.indexOf("--append-system-prompt") + 1];

    const start = JSON.parse((await handleToolCall("start_local_meeting", { agent: A, agenda: "checkout coupons", prototype: true })).content[0].text);
    const id = start.meetingId;
    assert.equal(start.prototypes.live.length, 1);
    const v1 = start.prototypes.live[0].url;
    assert.equal((await httpGet(v1)).status, 200);
    assert.ok(appendOf(argvs()[0]).startsWith("## Prototype mode"));
    const row = listLocalMeetings().find((m) => m.id === id);
    assert.equal(row.prototype, true);
    assert.equal(row.board_url, start.prototypes.board_url);

    const say1 = (await handleToolCall("say_local", { meeting_id: id, message: "Verdict on P1: APPROVE — clear" })).content[0].text;
    assert.equal((await httpGet(v1)).status, 410);
    const p1 = prompts()[1];
    assert.ok(p1.includes("**User:** Verdict on P1: APPROVE — clear\n\n## Prototype status"));
    assert.ok(p1.includes("Decide now"));
    assert.ok(appendOf(argvs()[1]).includes("## Prototype mode"), "directive on every call");
    assert.ok(say1.startsWith("Decision on P1: SHORTLIST — approved\n\n---\nPrototypes: "));
    // The status was added to that CLI prompt only: the stored caller message is the caller's words.
    assert.equal(localMeetings.get(id).messages[2].content, "Verdict on P1: APPROVE — clear");

    await handleToolCall("say_local", { meeting_id: id, message: "Great." });
    const p2 = prompts()[2];
    assert.ok(p2.includes("[Prototype P1 v1"), p2);
    assert.ok(!p2.includes(MARK));
    assert.ok(p2.includes("**User:** Verdict on P1: APPROVE — clear\n\n**Assistant:**"), "no stale status in the history");
    assert.ok(!p2.includes("## Prototype status"), "nothing pending, no status anywhere in the prompt");

    const end = (await handleToolCall("end_local_meeting", { meeting_id: id })).content[0].text;
    assert.ok(end.includes("## Shortlist for the human") && end.includes(MARK));
    assert.equal(prototypes.activePrototypeTrackers().length, 0);
  });
});

describe("public prototype collaboration", () => {
  test("posts a URL-free Markdown reference, screenshots under the turn, amendment after the public notice, scrubbed summary", async (t) => {
    let viewerUrl = "";
    let board = "";
    // The summarizer pastes the board and viewer URLs: the published summary must not carry them.
    const summaryText = () => `Summary: the human can watch ${board} and ${viewerUrl} until the end.`;
    const calls = stubFetch(t, script([
      "Opening thoughts: the checkout is too long.",
      webBlock(),
      "Verdict on P1: APPROVE — clean",
      "Decision on P1: SHORTLIST — approved",
    ], (url, init) =>
      url.startsWith(LLM) && JSON.parse(init.body).messages.at(-1).content.includes("**Full transcript:**")
        ? llmReply(summaryText())
        : undefined));
    // Screenshots are off in tests: inject one through the tracker and capture what is posted.
    const realOnTurn = prototypes.PrototypeTracker.prototype.onTurn;
    t.mock.method(prototypes.PrototypeTracker.prototype, "onTurn", async function (...args) {
      const r = await realOnTurn.apply(this, args);
      if (r.created) {
        viewerUrl = r.created.url;
        for (const view of ["desktop", "mobile"]) {
          r.attachments.push({ filename: `${r.created.label.replace(/ /g, "")}-${view}.png`, contentType: "image/png", bytes: Buffer.from([1, 2, 3]), caption: `${r.created.label} screenshot (${view})` });
        }
      }
      return r;
    });
    // Spy on what is posted, and let the channel really upload it (to the stubbed ntfy).
    const attachments = [];
    const realRecordAttachment = PublicChannel.prototype.recordAttachment;
    t.mock.method(PublicChannel.prototype, "recordAttachment", function (entry) {
      attachments.push(entry);
      return realRecordAttachment.call(this, entry);
    });

    const r = await startCollaboration([A, B], "checkout coupons", { ...opts, maxRounds: 2, public: true, prototype: true });
    const id = r.collaborationId;
    assert.ok(r.public.url.startsWith(NTFY + "/"));
    board = r.prototypes.board_url;
    for (const call of calls.filter(isLlm)) {
      const s = sys(call);
      const notice = s.indexOf("PUBLIC SESSION NOTICE");
      const amendment = s.indexOf(prototypes.publicPrototypeAmendment());
      assert.ok(notice >= 0 && amendment > notice && s.indexOf("## Prototype mode") > amendment, s);
    }
    await continueCollaboration(id, 1); // Plain proposes (message 1), then Sample assesses (message 2)
    // Plain proposed at message index 1, so its screenshots are posted as public turn 2, each titled by its
    // own caption (never the proposer's label, which would get "#2"/"#3" uniqueness suffixes).
    const injected = attachments.filter((a) => a.filename.startsWith("P1v1-"));
    assert.deepEqual(injected.map((a) => [a.turn, a.speaker, a.contentType]), [
      [2, "P1 v1 screenshot (desktop)", "image/png"],
      [2, "P1 v1 screenshot (mobile)", "image/png"],
    ]);
    assert.ok(injected.every((a) => a.speaker === publicLabel(a.speaker)), "clean under publicLabel");
    // Nothing is under assessment now, so the nudge is accepted; a pasted viewer URL is scrubbed from the post.
    assert.ok(viewerUrl.startsWith(board), viewerUrl);
    await nudgeCollaboration(id, `The human is watching ${viewerUrl} now`);
    await continueCollaboration(id, 1);
    const end = await endCollaboration(id, true);
    assert.match(end.publicBlock, /Public transcript: http:\/\/ntfy\.test\//);
    assert.match(end.prototypeOutcomes, /SHORTLIST/);
    assert.equal(end.summary, summaryText(), "the caller still gets the summary as written");

    const posted = calls.filter((c) => isNtfy(c) && c.init.method !== "GET").map((c) => JSON.stringify(c.body ?? ""));
    const all = posted.join("\n");
    assert.ok(all.includes("Prototype P1 v1") && all.includes("Inline coupon field"), "Markdown reference posted");
    assert.ok(!all.includes("<prototype"), "raw block never posted");
    assert.ok(!/127\.0\.0\.1|localhost/i.test(all), "no local address posted");
    assert.ok(all.includes("The human is watching [local prototype board] now"), "the nudge was posted, scrubbed");
    assert.match(all, /Summary: the human can watch \[[^\]]+\] and \[[^\]]+\] until the end\./, "the summary was posted, scrubbed");
    const port = new URL(board).port;
    assert.ok(!all.includes(`:${port}`), "board port never posted");

    // Titles as ntfy received them: JSON posts carry `title`; attachment uploads carry an RFC 2047 Title header.
    const decodeHeader = (v) =>
      String(v).replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, b64) => Buffer.from(b64, "base64").toString("utf8"));
    const sent = calls.filter((c) => isNtfy(c) && c.init.method !== "GET");
    const uploadTitles = sent.filter((c) => c.init.method === "PUT").map((c) => decodeHeader(c.init.headers.Title));
    assert.deepEqual(uploadTitles, ["#02 · P1 v1 screenshot (desktop)", "#02 · P1 v1 screenshot (mobile)"]);
    const titles = [...sent.map((c) => c.body?.title).filter(Boolean), ...uploadTitles];
    assert.ok(titles.length > uploadTitles.length);
    for (const title of titles) assert.doesNotMatch(title, / #\d+(?: \(\d+\/\d+\))?$/, `no uniqueness suffix in "${title}" (no duplicated persona)`);
  });
});

describe("final-round cutoff", () => {
  test("2 agents, max_rounds 2: a proposal in turn 2 is still assessed and decided; the last round may not start one", async (t) => {
    const calls = stubFetch(t, script([
      "Opening thoughts: the checkout is too long.",
      webBlock(),
      "Verdict on P1: APPROVE — clear",
      "Decision on P1: SHORTLIST — approved",
    ]));
    const r = await startCollaboration([A, B], "checkout coupons", { ...opts, maxRounds: 2, prototype: true });
    const done = await continueCollaboration(r.collaborationId, 2);
    assert.equal(done.status, "completed");
    const prompts = calls.filter(isLlm).map(lastUser);
    assert.equal(prompts.length, 4);
    // A proposal needs n-1 assessor turns plus the proposer's decision turn: turn 2 still leaves 2.
    assert.ok(!prompts[0].includes(FINAL_ROUND) && !prompts[1].includes(FINAL_ROUND), "turns 1 and 2 may still propose");
    assert.ok(prompts[2].includes(FINAL_ROUND) && prompts[3].includes(FINAL_ROUND), "the last n turns may not");
    // The assessor is told decisions are not theirs; the proposer that the decision is theirs alone.
    assert.ok(prompts[2].includes(OWNERSHIP) && prompts[3].includes(OWNERSHIP));
    assert.ok(!prompts[0].includes(OWNERSHIP), "no ownership line without prototype activity");
    const end = await endCollaboration(r.collaborationId);
    assert.match(end.prototypeOutcomes, /SHORTLIST/);
    assert.ok(end.prototypeOutcomes.split("## Shortlist for the human")[1].includes(MARK), "shortlisted, not closed undecided");
  });

  test("2 agents, max_rounds 1: the opening turn is already the final round", async (t) => {
    const calls = stubFetch(t, script(["Opening thoughts."]));
    const r = await startCollaboration([A, B], "t", { ...opts, maxRounds: 1, prototype: true });
    assert.ok(lastUser(calls[0]).includes(FINAL_ROUND));
    await endCollaboration(r.collaborationId);
  });
});

describe("auto-run failure", () => {
  test("a private auto-run that fails after the opening turn removes the session, its board and its sandbox", async (t) => {
    let n = 0;
    stubFetch(t, (url) => {
      if (!url.startsWith(LLM)) throw new Error(`Unexpected fetch: ${url}`);
      return ++n === 1 ? llmReply(webBlock()) : json(500, { error: "down" });
    });
    const before = sessionDirs();
    const rows = listCollaborations().length;
    const r = await handleToolCall("start_collaboration", {
      agents: [A, B], topic: "t", prototype: true, auto_run_rounds: 1, provider: "openai_compatible", model: "m", base_url: LLM,
    });
    assert.equal(r.isError, true);
    assert.equal(n, 2, "the opening turn ran, the second failed");
    assert.equal(listCollaborations().length, rows, "no orphan prototype session");
    assert.equal(prototypes.activePrototypeTrackers().length, 0, "board closed");
    assert.equal(liveCopies().length, 0, "sandbox removed");
    assert.equal(sessionDirs(), before);
  });
});

describe("turn keys", () => {
  test("serializeTurn runs steps of one session in order and survives a failing step", async () => {
    const session = {};
    const order = [];
    let release;
    const gate = new Promise((res) => (release = res));
    const first = serializeTurn(session, async () => {
      await gate;
      order.push("first");
      throw new Error("first failed");
    });
    const second = serializeTurn(session, () => order.push("second"));
    const other = serializeTurn({}, () => order.push("other session"));
    await other;
    assert.deepEqual(order, ["other session"], "another session never waits");
    release();
    await assert.rejects(first, /first failed/);
    await second;
    assert.deepEqual(order, ["other session", "first", "second"]);
  });

  test("a nudge issued while an agent turn is being processed waits for it and never shifts its key", async (t) => {
    stubFetch(t, script([
      "Opening thoughts.",
      webBlock(),
      "Verdict on P1: REJECT — too small",
      "Decision on P1: SCRAP — agreed",
    ]));
    const r = await startCollaboration([A, B], "checkout coupons", { ...opts, maxRounds: 3, prototype: true });
    const id = r.collaborationId;
    const collab = collaborations.get(id);
    // Hold the tracker on Plain's proposing turn.
    let release;
    const gate = new Promise((res) => (release = res));
    let entered;
    const pending = new Promise((res) => (entered = res));
    let held = false;
    const realOnTurn = prototypes.PrototypeTracker.prototype.onTurn;
    t.mock.method(prototypes.PrototypeTracker.prototype, "onTurn", async function (...args) {
      if (!held && String(args[1]).includes("<prototype")) {
        held = true;
        entered();
        await gate;
      }
      return realOnTurn.apply(this, args);
    });
    const turn = advanceCollaboration(collab);
    await pending;
    let nudgeSettled = false;
    const nudge = nudgeCollaboration(id, "keep it short");
    nudge.then(() => (nudgeSettled = true), () => (nudgeSettled = true));
    await new Promise((res) => setImmediate(res));
    assert.equal(nudgeSettled, false, "the nudge waits for the pending turn");
    assert.equal(collab.messages.length, 1, "nothing recorded while the turn is pending");
    release();
    await turn;
    // The turn proposed P1, so the nudge is now held instead of landing at the turn's index.
    await assert.rejects(nudge, /nudges are held/);
    assert.equal(collab.messages.length, 2);
    assert.ok(collab.messages[1].content.includes(MARK));

    await continueCollaboration(id, 1); // Sample rejects (P1 destroyed), Plain scraps
    const transcript = getCollaborationTranscript(id);
    assert.ok(transcript[1].content.includes("[Prototype P1 v1"), transcript[1].content);
    assert.ok(transcript.every((m) => !m.content.includes(MARK)), "the proposing turn is stubbed at its own index");
    await endCollaboration(id);
  });
});

describe("caller messages and history", () => {
  test("API meeting: the prototype status rides on the outgoing request only, never in history or the summary", async (t) => {
    const calls = stubFetch(t, script([webBlock(), "Decision on P1: SCRAP — fine", "Noted.", "Summary text"]));
    const m = await startMeeting(A, "checkout coupons", undefined, "openai_compatible", "m", LLM, "standard", undefined, false, true);
    await continueMeeting(m.meetingId, "Verdict on P1: REJECT — too busy");
    assert.ok(lastUser(calls[1]).startsWith("Verdict on P1: REJECT — too busy\n\n## Prototype status"), "status on this request");
    assert.equal(meetings.get(m.meetingId).messages[2].content, "Verdict on P1: REJECT — too busy", "stored: the caller's words");
    await continueMeeting(m.meetingId, "Thanks.");
    assert.equal(calls[2].body.messages[3].content, "Verdict on P1: REJECT — too busy", "resent without its old status");
    await endMeeting(m.meetingId, true);
    const summaryCall = calls.at(-1);
    assert.ok(summaryCall.body.messages.every((x) => !x.content.includes("## Prototype status")));
  });

  test("public prototype meeting: the published summary carries no board URL", async (t) => {
    let board = "";
    const calls = stubFetch(t, script([webBlock()], (url, init) =>
      url.startsWith(LLM) && JSON.parse(init.body).messages.at(-1).content.startsWith("Please provide a brief summary")
        ? llmReply(`Summary: watch ${board} for P1.`)
        : undefined));
    const m = await startMeeting(A, "checkout coupons", undefined, "openai_compatible", "m", LLM, "standard", undefined, true, true);
    board = m.prototypes.board_url;
    const out = await endMeeting(m.meetingId, true);
    assert.ok(out.startsWith(`Summary: watch ${board} for P1.`), "the caller gets the summary as written");
    const all = calls.filter((c) => isNtfy(c) && c.init.method !== "GET").map((c) => JSON.stringify(c.body ?? "")).join("\n");
    assert.match(all, /Summary: watch \[[^\]]+\] for P1\./);
    assert.ok(!/127\.0\.0\.1|localhost/i.test(all), "no local address posted");
  });
});

describe("from_session reads the stubbed views", () => {
  /** Capture the first create_agent prompt, then fail the call so the workshop stops there. */
  async function firstWorkshopPrompt(t, fromSession) {
    t.mock.restoreAll();
    const seen = stubFetch(t, () => json(500, { error: "stop here" }));
    await assert.rejects(createAgent({ ...opts, fromSession, write: false }));
    assert.ok(seen.length >= 1);
    return seen[0].body.messages.at(-1).content;
  }

  test("collaboration: destroyed prototype source never reaches create_agent prompts", async (t) => {
    stubFetch(t, script([webBlock(), "Verdict on P1: REJECT — no", "Decision on P1: SCRAP — ok"]));
    const r = await startCollaboration([A, B], "checkout coupons", { ...opts, maxRounds: 3, prototype: true });
    await continueCollaboration(r.collaborationId, 1); // Plain rejects (destroyed), Sample scraps
    const prompt = await firstWorkshopPrompt(t, r.collaborationId);
    assert.ok(prompt.includes("I propose an inline coupon field"), "the discussion is there");
    assert.ok(prompt.includes("[Prototype P1 v1"), "as a stub");
    assert.ok(!prompt.includes(MARK), "no destroyed source");
    await endCollaboration(r.collaborationId);
  });

  test("meeting: stubs and the caller's own words only", async (t) => {
    stubFetch(t, script([webBlock(), "Decision on P1: SCRAP — fine"]));
    const m = await startMeeting(A, "checkout coupons", undefined, "openai_compatible", "m", LLM, "standard", undefined, false, true);
    await continueMeeting(m.meetingId, "Verdict on P1: REJECT — too busy");
    const prompt = await firstWorkshopPrompt(t, m.meetingId);
    assert.ok(prompt.includes("**caller:** Verdict on P1: REJECT — too busy"));
    assert.ok(prompt.includes("[Prototype P1 v1"));
    assert.ok(!prompt.includes(MARK));
    assert.ok(!prompt.includes("## Prototype status"));
    await endMeeting(m.meetingId);
  });
});

describe("non-prototype sessions are unchanged", () => {
  test("collaboration prompts and results are byte-identical to the pre-prototype format", async (t) => {
    const dirsBefore = sessionDirs();
    for (const flag of [undefined, false]) {
      const calls = stubFetch(t, script(["reply 0", "reply 1"]));
      const r = await startCollaboration([A, B], "topic", { ...opts, maxRounds: 2, ...(flag !== undefined && { prototype: flag }) });
      assert.ok(!("prototypes" in r));
      await advanceCollaboration(collaborations.get(r.collaborationId));
      assert.equal(sys(calls[0]), "You are Sample.\n");
      assert.equal(
        lastUser(calls[0]),
        `You are entering a collaborative discussion with other agents.\n\n**Topic:** topic\n\n**Participants:** ${A}, ${B}\n\n` +
          `Please share your initial thoughts on this topic. Be substantive but concise. ` +
          `Other agents will respond, and you'll have opportunities to refine your position.`
      );
      assert.equal(sys(calls[1]), "You are Plain. No frontmatter here.\n");
      assert.equal(
        lastUser(calls[1]),
        `You are in a collaborative discussion.\n\n**Topic:** topic\n\n**Participants:** ${A}, ${B}\n\n**Discussion so far:**\n\n` +
          `**${A}:** reply 0\n\n---\n\nIt's your turn to respond. Consider what others have said, ` +
          `build on good ideas, respectfully challenge points you disagree with, and move toward actionable conclusions.`
      );
      const row = listCollaborations().find((c) => c.id === r.collaborationId);
      assert.equal(row.prototype, false);
      assert.ok(!("board_url" in row));
      const cont = await continueCollaboration(r.collaborationId, 0);
      assert.ok(!("prototypes" in cont));
      await nudgeCollaboration(r.collaborationId, "n");
      const out = (await handleToolCall("end_collaboration", { collaboration_id: r.collaborationId })).content[0].text;
      assert.equal(out, `## Collaboration Transcript\n\n**${A}:** reply 0\n\n---\n\n**${B}:** reply 1\n\n---\n\n**ORCHESTRATOR:** n\n\n---\n\n`);
      t.mock.restoreAll();
    }
    assert.equal(sessionDirs(), dirsBefore, "no sandbox for non-prototype sessions");
  });

  test("meeting system prompt, history and say output are unchanged", async (t) => {
    const calls = stubFetch(t, script(["r0", "r1"]));
    const start = JSON.parse((await handleToolCall("start_meeting", {
      agent: A, agenda: "agenda", provider: "openai_compatible", model: "m", base_url: LLM,
    })).content[0].text);
    assert.deepEqual(Object.keys(start), ["meetingId", "response"]);
    const said = await handleToolCall("say", { meeting_id: start.meetingId, message: "hi" });
    assert.equal(said.content[0].text, "r1");
    assert.deepEqual(calls[1].body.messages, [
      { role: "system", content: "You are Sample.\n" },
      { role: "user", content: "agenda" },
      { role: "assistant", content: "r0" },
      { role: "user", content: "hi" },
    ]);
    const row = listMeetings().find((m) => m.id === start.meetingId);
    assert.equal(row.prototype, false);
    assert.ok(!("board_url" in row));
    const end = await continueMeeting(start.meetingId, "bye").then(() => endMeeting(start.meetingId));
    assert.equal(end, `Meeting ${start.meetingId} with ${A} ended.`);
  });
});

describe("debug_env", () => {
  test("reports the prototype configuration", async (t) => {
    stubFetch(t, () => json(500, {}));
    const d = JSON.parse((await handleToolCall("debug_env", {})).content[0].text);
    assert.equal(d.version, "0.4.0");
    assert.equal(d.prototypes.dir, PROTO_ROOT);
    assert.equal(typeof d.prototypes.screenshots, "boolean");
    assert.equal(d.prototypes.open_browser, false);
    assert.equal(typeof d.prototypes.ttl_ms, "number");
    assert.equal(d.prototypes.active_boards, 0);
    assert.ok("chrome" in d.prototypes);
  });
});
