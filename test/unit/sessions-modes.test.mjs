import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { startMeeting, endMeeting, listMeetings, setMeetingRecordHook } = await import("../../dist/sessions/meetings.js");
const {
  startCollaboration,
  continueCollaboration,
  nudgeCollaboration,
  endCollaboration,
  listCollaborations,
  collaborations,
  setCollaborationRecordHook,
} = await import("../../dist/sessions/collaborations.js");
const { startLocalMeeting, continueLocalMeeting, endLocalMeeting, listLocalMeetings, buildClaudeCliArgs } =
  await import("../../dist/sessions/local-meetings.js");
const modes = await import("../../dist/sessions/modes.js");

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => resolve(here, "../fixtures/agents", n);
const sample = fx("sample.md"); // "You are Sample.\n"
const plain = fx("plain.md"); // "You are Plain. No frontmatter here.\n"
const BASE = "http://localhost:1234/v1";
const reply = (i) => json(200, { choices: [{ message: { content: `reply ${i}` } }] });
const opts = { provider: "openai_compatible", model: "m", baseUrl: BASE };
const sys = (call) => call.body.messages[0].content;
const user = (call) => call.body.messages[1].content;

describe("mode constants", () => {
  test("lists", () => {
    assert.deepEqual([...modes.MEETING_MODES], ["standard", "debate"]);
    assert.deepEqual([...modes.COLLABORATION_MODES], ["collaborate", "debate", "waffle-house"]);
  });
  test("directives carry no legacy names or home paths", () => {
    const text = [
      modes.buildChallengerDirective("f"),
      modes.buildProponentDirective("f"),
      modes.buildAttackerDirective(),
      modes.buildDefenderOpeningPrompt(),
      modes.buildDefenderTurnPrompt(2),
      modes.buildAttackerTurnPrompt(),
      modes.buildWaffleHouseSummaryPrompt("t"),
      modes.buildDebateSummaryPrompt("t"),
    ].join("\n");
    assert.ok(!new RegExp(["vo" + "uch", "/Us" + "ers/"].join("|"), "i").test(text));
  });
});

describe("unknown modes are rejected at runtime", () => {
  for (const bad of ["Debate", "waffle_house", "waffle", ""]) {
    test(`collaboration mode "${bad}"`, async (t) => {
      const calls = stubFetch(t, (_u, _i, i) => reply(i));
      await assert.rejects(
        startCollaboration([sample, plain], "x", { ...opts, mode: bad }),
        (e) => e.message === `Unknown mode "${bad}". Valid modes: collaborate, debate, waffle-house`
      );
      assert.equal(calls.length, 0);
    });
  }
  test("meeting rejects waffle-house and case variants", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    for (const bad of ["waffle-house", "Debate"]) {
      await assert.rejects(
        startMeeting(sample, "a", undefined, "openai_compatible", "m", BASE, bad),
        (e) => e.message === `Unknown mode "${bad}". Valid modes: standard, debate`
      );
      await assert.rejects(
        startLocalMeeting(sample, "a", undefined, bad),
        (e) => e.message === `Unknown mode "${bad}". Valid modes: standard, debate`
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("meeting debate mode", () => {
  test("directive on the system prompt, suffix on the user message, mode listed", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { meetingId } = await startMeeting(sample, "agenda", "ctx", "openai_compatible", "m", BASE, "debate", "pricing");
    assert.ok(sys(calls[0]).startsWith("You are Sample.\n"));
    assert.ok(sys(calls[0]).includes("Debate role: challenger"));
    assert.ok(sys(calls[0]).includes("Focus your challenge on: pricing."));
    assert.ok(user(calls[0]).startsWith("agenda\n\n---\n\nctx"));
    assert.ok(user(calls[0]).includes("You are the challenger in this meeting"));
    assert.equal(listMeetings().find((m) => m.id === meetingId).mode, "debate");
    await endMeeting(meetingId);
  });
  test("standard mode adds nothing", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { meetingId } = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", BASE);
    assert.equal(sys(calls[0]), "You are Sample.\n");
    assert.equal(user(calls[0]), "agenda");
    assert.equal(listMeetings().find((m) => m.id === meetingId).mode, "standard");
    await endMeeting(meetingId);
  });
  test("record hook sees every message and a throwing hook never breaks the session", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const seen = [];
    setMeetingRecordHook((_m, msg) => {
      seen.push(msg.role);
      throw new Error("boom");
    });
    t.after(() => setMeetingRecordHook(undefined));
    const { meetingId } = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", BASE);
    assert.deepEqual(seen, ["user", "assistant"]);
    await endMeeting(meetingId);
  });
});

describe("local meeting debate mode (fake claude on PATH)", () => {
  test("arg builder", () => {
    assert.deepEqual(buildClaudeCliArgs("/p.md", "hi"), ["--system-prompt-file", "/p.md", "-p", "hi"]);
    assert.deepEqual(buildClaudeCliArgs("/p.md", "hi", "DIR"), [
      "--system-prompt-file", "/p.md", "--append-system-prompt", "DIR", "-p", "hi",
    ]);
  });

  test("debate passes --append-system-prompt on every call; standard never does", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const log = join(dir, "argv.jsonl");
    const script = join(dir, "claude");
    writeFileSync(
      script,
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("fake reply");\n`
    );
    chmodSync(script, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    t.after(() => {
      process.env.PATH = oldPath;
    });
    const argvs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

    const d = await startLocalMeeting(sample, "agenda", undefined, "debate", "latency");
    assert.equal(d.response, "fake reply");
    await continueLocalMeeting(d.meetingId, "more");
    await endLocalMeeting(d.meetingId, true);
    const calls = argvs();
    assert.equal(calls.length, 3);
    for (const a of calls) {
      const i = a.indexOf("--append-system-prompt");
      assert.ok(i >= 0, `missing flag in ${JSON.stringify(a)}`);
      assert.ok(a[i + 1].includes("Debate role: challenger") && a[i + 1].includes("latency"));
      assert.equal(a[0], "--system-prompt-file");
      assert.equal(a[a.length - 2], "-p");
    }
    assert.ok(calls[0].at(-1).includes("You are the challenger in this meeting"));
    assert.equal(listLocalMeetings().length, 0);

    const s = await startLocalMeeting(sample, "agenda");
    assert.equal(listLocalMeetings().find((m) => m.id === s.meetingId).mode, "standard");
    assert.ok(!argvs().at(-1).includes("--append-system-prompt"));
    await endLocalMeeting(s.meetingId);
  });
});

describe("debate collaboration", () => {
  test("directives land only on challengers' system prompts; proponent gets user-turn text", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([sample, plain], "topic", {
      ...opts, mode: "debate", debateFocus: "cost", autoRun: true, runRounds: 1,
    });
    assert.equal(sys(calls[0]), "You are Sample.\n"); // proponent opening
    assert.ok(user(calls[0]).includes("You are the **proponent**"));
    assert.ok(sys(calls[1]).includes("Debate role: challenger")); // Plain
    assert.ok(user(calls[1]).includes("Press on the weakest point"));
    assert.equal(sys(calls[2]), "You are Sample.\n"); // proponent again, no directive in system prompt
    assert.ok(user(calls[2]).includes("State the position"));
    assert.equal(listCollaborations().find((c) => c.id === collaborationId).mode, "debate");
    await endCollaboration(collaborationId);
  });

  test("unchanged semantics: completes when floor(agentTurns/N) >= maxRounds", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([sample, plain], "topic", { ...opts, maxRounds: 2 });
    const r = await continueCollaboration(collaborationId, 5);
    // 2 agents x 2 rounds = 4 agent turns total (opening + 3)
    assert.equal(r.newMessages.length, 3);
    assert.equal(r.status, "completed");
    await endCollaboration(collaborationId);
  });
});

describe("waffle-house", () => {
  const A = fx("sample.md");
  const B = fx("plain.md");
  const C = fx("third.md");

  test("needs at least 2 agents", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    await assert.rejects(startCollaboration([A], "x", { ...opts, mode: "waffle-house" }), /at least 2 agents/);
  });

  test("attacker directive only on attackers; defender prompt is user-turn text", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([A, B, C], "pineapple on pizza", {
      ...opts, mode: "waffle-house", autoRun: true, runRounds: 1, maxRounds: 3,
    });
    // opening + attacker B + attacker C + defender rebuttal
    assert.equal(calls.length, 4);
    // defender: system prompt untouched, both turns
    for (const i of [0, 3]) {
      assert.equal(sys(calls[i]), "You are Sample.\n");
      assert.ok(!sys(calls[i]).includes("attacker"));
    }
    assert.ok(user(calls[0]).includes("You are the **defender**"));
    assert.ok(user(calls[0]).includes("Current position (v1):"));
    assert.ok(user(calls[0]).includes(`${B} (attacker)`));
    // attackers: directive in system prompt
    for (const i of [1, 2]) {
      assert.ok(sys(calls[i]).includes("Waffle-house role: attacker"));
      assert.ok(sys(calls[i]).includes("never make threats"));
      assert.ok(sys(calls[i]).includes("never use slurs"));
      assert.ok(sys(calls[i]).includes("single most damaging attack"));
      assert.ok(user(calls[i]).includes("It's your turn to attack"));
    }
    // defender turn: answer EVERY attack, rebut/concede/revise, vN restated
    const d = user(calls[3]);
    assert.ok(d.includes("Answer EVERY attack made since your last turn"));
    assert.ok(/rebuts? it, concede it, or revise/.test(d));
    assert.ok(d.includes("Yield to arguments, not to tone"));
    assert.ok(d.includes('End with "Current position (v2):"'));
    assert.equal(listCollaborations().find((c) => c.id === collaborationId).mode, "waffle-house");
    await endCollaboration(collaborationId);
  });

  test("exact speaking order for 3 agents over 2 rounds; final turn is the defender; total 1 + 2*3", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId, messages } = await startCollaboration([A, B, C], "topic", {
      ...opts, mode: "waffle-house", maxRounds: 2,
    });
    assert.equal(messages.length, 1);
    // ask for far more than remains; must stop at the cap
    const r = await continueCollaboration(collaborationId, 10);
    const order = collaborations.get(collaborationId).messages.map((m) => m.agent);
    assert.deepEqual(order, [A, B, C, A, B, C, A]);
    assert.equal(order.length, 1 + 2 * 3);
    assert.equal(order.at(-1), A);
    assert.equal(r.status, "completed");
    assert.equal(calls.length, 7);
    // defender versions increment: v1 opening, v2, v3, v4
    const defCalls = [calls[0], calls[3], calls[6]];
    assert.ok(user(defCalls[0]).includes("(v1)"));
    assert.ok(user(defCalls[1]).includes("(v2)"));
    assert.ok(user(defCalls[2]).includes("(v3)"));
    await endCollaboration(collaborationId);
  });

  test("continue_collaboration(1) is one whole volley ending on the defender", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([A, B, C], "topic", { ...opts, mode: "waffle-house", maxRounds: 3 });
    const r = await continueCollaboration(collaborationId, 1);
    assert.deepEqual(r.newMessages.map((m) => m.agent), [B, C, A]);
    assert.equal(r.status, "running");
    assert.equal(r.currentRound, 1); // recomputed after every recorded turn: one full volley done
    const r2 = await continueCollaboration(collaborationId, 1);
    assert.deepEqual(r2.newMessages.map((m) => m.agent), [B, C, A]);
    assert.equal(r2.currentRound, 2);
    assert.equal(r2.status, "running");
    const r3 = await continueCollaboration(collaborationId, 1);
    assert.equal(r3.newMessages.length, 3);
    // exactly the budget (1 + 3*3 turns): completed with no spare iteration
    assert.equal(r3.status, "completed");
    assert.equal(r3.currentRound, 3);
    assert.equal(collaborations.get(collaborationId).messages.at(-1).agent, A);
    await endCollaboration(collaborationId);
  });

  test("nudges do not shift rounds or whose turn; they are still in the transcript", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([A, B, C], "topic", { ...opts, mode: "waffle-house", maxRounds: 1 });
    await continueCollaboration(collaborationId, 0); // no-op sanity
    // volley part 1: attacker B, then nudge mid-volley, then attacker C and defender
    const collab = collaborations.get(collaborationId);
    await (await import("../../dist/sessions/collaborations.js")).advanceCollaboration(collab);
    await nudgeCollaboration(collaborationId, "focus on cost");
    await nudgeCollaboration(collaborationId, "and on taste");
    const r = await continueCollaboration(collaborationId, 1);
    // one volley cap: 1 + 1*3 = 4 agent turns; already had opening + B, so only C and A remain
    assert.deepEqual(r.newMessages.map((m) => m.agent), [C, A]);
    assert.equal(r.status, "completed"); // the cap is hit mid-call; the spare iteration flips status
    const r2 = await continueCollaboration(collaborationId, 1);
    assert.equal(r2.newMessages.length, 0);
    assert.equal(r2.status, "completed");
    const agents = collab.messages.map((m) => m.agent);
    assert.deepEqual(agents, [A, B, "ORCHESTRATOR", "ORCHESTRATOR", C, A]);
    // the nudges are visible to later speakers
    assert.ok(user(calls[3]).includes("focus on cost"));
    await endCollaboration(collaborationId);
  });

  test("nudges do not bring a plain collaboration's end forward", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([A, B], "topic", { ...opts, maxRounds: 2 });
    await nudgeCollaboration(collaborationId, "n1");
    await nudgeCollaboration(collaborationId, "n2");
    await nudgeCollaboration(collaborationId, "n3");
    const r = await continueCollaboration(collaborationId, 5);
    assert.equal(r.newMessages.length, 3); // 4 agent turns total, same as with no nudges
    assert.deepEqual(
      collaborations.get(collaborationId).messages.filter((m) => m.agent !== "ORCHESTRATOR").map((m) => m.agent),
      [A, B, A, B]
    );
    await endCollaboration(collaborationId);
  });

  test("summary is written by the defender with the required sections", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([A, B], "topic", { ...opts, mode: "waffle-house" });
    const { summary } = await endCollaboration(collaborationId, true);
    assert.equal(summary, "reply 1");
    const last = calls.at(-1);
    assert.equal(sys(last), "You are Sample.\n");
    const p = user(last);
    assert.ok(p.includes("final form of the idea"));
    assert.ok(p.includes("which attack forced each change"));
    assert.ok(p.includes("unanswered"));
    assert.ok(p.includes("confidence"));
  });

  test("record hook fires for agent turns and nudges; failing hook is isolated", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const seen = [];
    setCollaborationRecordHook((_c, m) => {
      seen.push(m.agent);
      throw new Error("boom");
    });
    t.after(() => setCollaborationRecordHook(undefined));
    const { collaborationId } = await startCollaboration([A, B], "topic", { ...opts, mode: "waffle-house" });
    await nudgeCollaboration(collaborationId, "hey");
    await continueCollaboration(collaborationId, 1);
    assert.deepEqual(seen, [A, "ORCHESTRATOR", B, A]);
    await endCollaboration(collaborationId);
  });
});

describe("collaboration robustness", () => {
  test("waffle-house auto_run with exactly the budget ends completed with accurate round", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const r = await startCollaboration([sample, plain, fx("third.md")], "topic", {
      ...opts, mode: "waffle-house", maxRounds: 2, autoRun: true, runRounds: 2,
    });
    assert.equal(r.status, "completed");
    const [row] = listCollaborations().filter((c) => c.id === r.collaborationId);
    assert.equal(row.currentRound, 2);
    assert.equal(collaborations.get(r.collaborationId).messages.length, 7);
    await endCollaboration(r.collaborationId);
  });

  test("duplicate persona in waffle-house: defender versions count only defender turns", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([sample, sample, plain], "topic", { ...opts, mode: "waffle-house", maxRounds: 2 });
    await continueCollaboration(collaborationId, 2);
    const defenderCalls = [calls[0], calls[3], calls[6]];
    assert.ok(user(defenderCalls[0]).includes("(v1)"));
    assert.ok(user(defenderCalls[1]).includes("(v2)"));
    assert.ok(user(defenderCalls[2]).includes("(v3)"));
    assert.ok(user(calls[2]).includes("(attacker)"), "history labels roles");
    await endCollaboration(collaborationId);
  });

  test("first LLM call failing leaves no orphan collaboration", async (t) => {
    stubFetch(t, () => json(500, { error: "boom" }));
    const before = listCollaborations().length;
    await assert.rejects(startCollaboration([sample, plain], "topic", { ...opts, mode: "waffle-house" }));
    assert.equal(listCollaborations().length, before);
  });

  test("currentRound in list_collaborations is accurate after each turn", async (t) => {
    stubFetch(t, (_u, _i, i) => reply(i));
    const { collaborationId } = await startCollaboration([sample, plain], "topic", { ...opts, maxRounds: 3 });
    await continueCollaboration(collaborationId, 1);
    const row = listCollaborations().find((c) => c.id === collaborationId);
    assert.equal(row.currentRound, 1);
    await endCollaboration(collaborationId);
  });
});
