import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, statSync, chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const {
  startLocalMeeting,
  continueLocalMeeting,
  endLocalMeeting,
  listLocalMeetings,
  buildClaudeCliArgs,
  resetClaudeCliFeatures,
  liveLocalMeetingPids,
  stopLocalMeetingProcesses,
} = await import("../../dist/sessions/local-meetings.js");
const modes = await import("../../dist/sessions/modes.js");
const { readArchivedSession } = await import("../../dist/sessions/archive.js");
const { sessionDissentDrafts } = await import("../../dist/sessions/dissents.js");

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
    assert.deepEqual([...modes.COLLABORATION_MODES], ["collaborate", "debate", "waffle-house", "conversation"]);
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
      modes.buildDissentSummaryPrompt("challenger", "t"),
      modes.buildDissentSummaryPrompt("attacker", "t"),
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
        (e) => e.message === `Unknown mode "${bad}". Valid modes: collaborate, debate, waffle-house, conversation`
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
  const FLAGS = ["-p", "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--strict-mcp-config", "--restricted", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome"];

  test("arg builder: no positional prompt, read-only tools, no permission prompts, no MCP servers", () => {
    assert.deepEqual(buildClaudeCliArgs("/p.md"), ["--system-prompt-file", "/p.md", ...FLAGS]);
    assert.deepEqual(buildClaudeCliArgs("/p.md", "DIR"), [
      "--system-prompt-file", "/p.md", "--append-system-prompt", "DIR", ...FLAGS,
    ]);
  });

  /**
   * A fake `claude` that records its argv and stdin, then runs `body(dir)` (JavaScript source; default:
   * print "fake reply"). The prompt arrives on stdin only.
   */
  function fakeClaude(t, body = () => 'process.stdout.write("fake reply");', { help = "  --permission-prompts --restricted --settings --strict-mcp-config --tools --permission-mode --disable-slash-commands --no-chrome\n" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const log = join(dir, "runs.jsonl");
    const script = join(dir, "claude");
    // --help (the one-time feature check) is answered and counted separately from real runs.
    writeFileSync(
      script,
      `#!${process.execPath}\nif (process.argv.includes("--help")) {\n` +
        `  require("node:fs").appendFileSync(${JSON.stringify(join(dir, "help.log"))}, "help\\n");\n` +
        `  process.stdout.write(${JSON.stringify(help)});\n  process.exit(0);\n}\n` +
        `let input = "";\nprocess.stdin.setEncoding("utf8");\n` +
        `process.stdin.on("data", (d) => (input += d));\nprocess.stdin.on("end", () => {\n` +
        `  require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + "\\n");\n` +
        `  ${body(dir)}\n});\n`
    );
    chmodSync(script, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    t.after(() => {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    });
    return { dir, runs: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
  }

  test("debate passes --append-system-prompt on every call; standard never does", async (t) => {
    const { runs } = fakeClaude(t);

    const d = await startLocalMeeting(sample, "agenda", undefined, "debate", "latency");
    assert.equal(d.response, "fake reply");
    await continueLocalMeeting(d.meetingId, "more");
    await endLocalMeeting(d.meetingId, true);
    const calls = runs();
    assert.equal(calls.length, 3);
    for (const { argv: a, stdin } of calls) {
      const i = a.indexOf("--append-system-prompt");
      assert.ok(i >= 0, `missing flag in ${JSON.stringify(a)}`);
      assert.ok(a[i + 1].includes("Debate role: challenger") && a[i + 1].includes("latency"));
      assert.equal(a[0], "--system-prompt-file");
      assert.deepEqual(a.slice(-FLAGS.length), FLAGS, "the prompt is never an argument");
      assert.ok(stdin.length > 0 && !a.some((arg) => arg.includes(stdin)));
    }
    assert.ok(calls[0].stdin.includes("You are the challenger in this meeting"));
    assert.ok(calls[1].stdin.includes("**User:** more"), "history goes in on stdin");
    assert.ok(calls[2].stdin.includes("<DISSENT>"), "the local challenger is asked for its own dissent");
    assert.equal(listLocalMeetings().length, 0);

    const s = await startLocalMeeting(sample, "agenda");
    assert.equal(listLocalMeetings().find((m) => m.id === s.meetingId).mode, "standard");
    assert.ok(!runs().at(-1).argv.includes("--append-system-prompt"));
    await endLocalMeeting(s.meetingId);
  });

  test("a prompt that looks like flags reaches the CLI verbatim on stdin", async (t) => {
    const { runs } = fakeClaude(t);
    const agenda = "--dangerously-skip-permissions --tools Bash -- and a $(subshell) `tick`";
    const { meetingId } = await startLocalMeeting(sample, agenda);
    await endLocalMeeting(meetingId);
    const [{ argv, stdin }] = runs();
    assert.equal(stdin, agenda);
    assert.ok(!argv.includes("--dangerously-skip-permissions") && !argv.includes("Bash"));
  });

  test("local debate closing statements retain a dissent for contract import", async (t) => {
    const block = "<DISSENT>\nclaim: Retries duplicate orders.\npredicted_failure: The order check fails.\n</DISSENT>";
    fakeClaude(t, () => `process.stdout.write(${JSON.stringify(block)});`);
    const { meetingId } = await startLocalMeeting(sample, "Orders", undefined, "debate");
    assert.equal(await endLocalMeeting(meetingId, true), block);
    const [draft] = sessionDissentDrafts(readArchivedSession(meetingId));
    assert.equal(draft.by, sample);
    assert.equal(draft.claim, "Retries duplicate orders.");
    assert.deepEqual(draft.source, { kind: "debate", ref: meetingId });
  });

  test("CLI errors are scrubbed of secrets and capped", async (t) => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-local-meeting-secret-1234567890";
    t.after(() => delete process.env.ANTHROPIC_API_KEY);
    fakeClaude(t, () => `process.stderr.write("auth failed for sk-ant-local-meeting-secret-1234567890 " + "x".repeat(2000)); process.exit(3);`);
    const err = await startLocalMeeting(sample, "agenda").then(() => null, (e) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /^Claude CLI exited with code 3: auth failed for \[redacted:env:ANTHROPIC_API_KEY\]/);
    assert.ok(!err.message.includes("sk-ant-local"));
    assert.ok(err.message.length < 560, `${err.message.length} chars`);
  });

  test("ROUNDTABLE_LOCAL_TIMEOUT_MS bounds a call and the CLI's whole process group is killed", { skip: process.platform === "win32" }, async (t) => {
    process.env.ROUNDTABLE_LOCAL_TIMEOUT_MS = "1000";
    t.after(() => delete process.env.ROUNDTABLE_LOCAL_TIMEOUT_MS);
    // A grandchild that would outlive the CLI unless the whole group is killed.
    const { dir } = fakeClaude(t, (d) =>
      `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(join(d, "grandchild.pid"))}, String(c.pid));\n  setInterval(() => {}, 1000);`
    );
    const t0 = Date.now();
    await assert.rejects(startLocalMeeting(sample, "agenda"), /Claude CLI timed out after 1000ms \(ROUNDTABLE_LOCAL_TIMEOUT_MS\)/);
    assert.ok(Date.now() - t0 < 5000);
    const pidFile = join(dir, "grandchild.pid");
    const end = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(!alive(), "the grandchild was killed with the group");
  });

  test("the CLI runs in the workspace, so Read/Glob/Grep cannot see past it", async (t) => {
    const { runs } = fakeClaude(t, () => 'process.stdout.write(process.cwd());');
    const { meetingId, response } = await startLocalMeeting(sample, "agenda");
    await endLocalMeeting(meetingId);
    assert.equal(response, realpathSync.native(process.env.ROUNDTABLE_WORKSPACE_DIR));
    assert.equal(runs().length, 1);
  });

  test("a workspace of / or the home directory gives the CLI an empty private directory instead", { skip: process.platform === "win32" }, () => {
    const state = mkdtempSync(join(tmpdir(), "rt-cwd-"));
    try {
      for (const ws of ["/", process.env.HOME]) {
        mkdirSync(ws, { recursive: true });
        const r = spawnSync(process.execPath, ["--input-type=module", "-e",
          `const m = await import(${JSON.stringify(new URL("../../dist/sessions/local-meetings.js", import.meta.url).href)}); process.stdout.write(m.localMeetingCwd());`,
        ], { env: { ...process.env, ROUNDTABLE_WORKSPACE_DIR: ws, ROUNDTABLE_HOME: state }, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, join(state, "local-meeting-workspace"), ws);
        assert.match(r.stderr, /Set ROUNDTABLE_WORKSPACE_DIR to the project/);
        assert.equal(statSync(r.stdout).mode & 0o777, 0o700);
        assert.deepEqual(readdirSync(r.stdout), []);
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("--permission-prompts is feature-detected once per CLI and omitted when the CLI lacks it", async (t) => {
    resetClaudeCliFeatures();
    const { dir, runs } = fakeClaude(t, undefined, { help: "--restricted --settings --strict-mcp-config --tools --permission-mode --disable-slash-commands --no-chrome\n" });
    const { meetingId } = await startLocalMeeting(sample, "agenda");
    await continueLocalMeeting(meetingId, "more");
    await endLocalMeeting(meetingId);
    for (const { argv } of runs()) {
      assert.ok(!argv.includes("--permission-prompts"), JSON.stringify(argv));
      assert.ok(argv.includes("dontAsk") && argv.includes("--strict-mcp-config"));
    }
    assert.equal(readFileSync(join(dir, "help.log"), "utf8"), "help\n", "one --help for the whole meeting");
    assert.deepEqual(buildClaudeCliArgs("/p.md", undefined, { permissionPrompts: false }), [
      "--system-prompt-file", "/p.md", "-p", "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--strict-mcp-config", "--restricted", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome",
    ]);
  });

  test("missing safety flags fail closed, name the flag, and cache the failed preflight", async (t) => {
    const required = ["--restricted", "--settings", "--strict-mcp-config", "--tools", "--permission-mode", "--disable-slash-commands", "--no-chrome"];
    for (const missing of required) {
      const { dir, runs } = fakeClaude(t, undefined, { help: required.filter(f => f !== missing).join(" ") });
      for (let i = 0; i < 2; i++) await assert.rejects(startLocalMeeting(sample, "agenda"), e => e.message.includes(missing));
      assert.equal(runs().length, 0);
      assert.equal(readFileSync(join(dir, "help.log"), "utf8"), "help\n");
    }
  });

  test("a failure reported on stdout reaches the error when stderr is empty", async (t) => {
    fakeClaude(t, () => 'process.stdout.write("Not logged in · Please run /login"); process.exit(1);');
    await assert.rejects(startLocalMeeting(sample, "agenda"), /^Error: Claude CLI exited with code 1: Not logged in · Please run \/login$/);
  });

  /** A fake CLI that records its pid and hangs; returns the pid file. */
  function hangingClaude(t) {
    const { dir } = fakeClaude(t, (d) => `require("node:fs").writeFileSync(${JSON.stringify(join(d, "cli.pid"))}, String(process.pid));\n  setInterval(() => {}, 1000);`);
    return join(dir, "cli.pid");
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function waitFor(cond, ms = 5000) {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test("shutdown stops every live CLI (SIGTERM, then SIGKILL) and the meeting call fails", { skip: process.platform === "win32" }, async (t) => {
    const pidFile = hangingClaude(t);
    const call = startLocalMeeting(sample, "agenda").then(() => null, (e) => e);
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.deepEqual(liveLocalMeetingPids(), [pid]);
    await stopLocalMeetingProcesses(200);
    assert.match((await call).message, /Claude CLI exited with signal SIG(TERM|KILL)/);
    await waitFor(() => !alive(pid));
    assert.deepEqual(liveLocalMeetingPids(), []);
  });

  test("process exit SIGKILLs any CLI still running", { skip: process.platform === "win32" }, async (t) => {
    const pidFile = hangingClaude(t);
    const child = spawnSync(process.execPath, [
      "--import", new URL("../fixtures/foundation/test-env.mjs", import.meta.url).href,
      "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(new URL("../../dist/sessions/local-meetings.js", import.meta.url).href)});\n` +
        `const fs = await import("node:fs");\n` +
        `m.startLocalMeeting(${JSON.stringify(sample)}, "agenda").catch(() => {});\n` +
        `const t0 = Date.now();\n` +
        `while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));\n` +
        `process.exit(0);`,
    ], { env: process.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitFor(() => !alive(pid));
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
    const last = calls[1]; // defender summary precedes the attacker's own closing statement
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

describe("adversarial closing summaries", () => {
  const block = "<DISSENT>\nclaim: Retries duplicate orders.\npredicted_failure: The order check fails.\n</DISSENT>";
  for (const mode of ["debate", "waffle-house"]) {
    test(`${mode} preserves every adversary's statement and author separately from the main summary`, async (t) => {
      const third = fx("third.md");
      const calls = stubFetch(t, (_u, _i, i) => json(200, { choices: [{ message: { content:
        i === 1 ? `Main summary\n${block}` : i >= 2 ? block : "Opening position",
      } }] }));
      const { collaborationId } = await startCollaboration([sample, plain, third], "Orders", { ...opts, mode });
      const result = await endCollaboration(collaborationId, true);
      assert.equal(result.summary, `Main summary\n${block}`);
      assert.deepEqual(result.dissentSummaries, [{ agent: plain, content: block }, { agent: third, content: block }]);
      assert.equal(calls.length, 4);
      for (const [i, label] of [[2, "Plain"], [3, "Third"]]) {
        assert.ok(sys(calls[i]).startsWith(`You are ${label}.`));
        assert.ok(user(calls[i]).includes(`You were the ${mode === "debate" ? "challenger" : "attacker"}`));
        assert.ok(user(calls[i]).includes("<DISSENT>"));
        assert.ok(user(calls[i]).includes("500 characters"));
        assert.ok(user(calls[i]).includes("16 blocks"));
        assert.ok(user(calls[i]).includes("Opening position"));
        assert.ok(!user(calls[i]).includes("Main summary"), "the proponent's summary is not another participant's statement");
      }
      const archived = readArchivedSession(collaborationId);
      assert.deepEqual(archived.dissentSummaries, result.dissentSummaries);
      const drafts = sessionDissentDrafts(archived);
      assert.deepEqual(drafts.map((d) => d.by), [plain, third]);
      assert.ok(drafts.every((d) => d.source.ref === collaborationId && d.tripwire === undefined));
    });
  }

  test("debate meeting closing statement is tagged, archived, and attributed to its challenger", async (t) => {
    const calls = stubFetch(t, (_u, _i, i) => json(200, { choices: [{ message: { content: i ? block : "Opening" } }] }));
    const { meetingId } = await startMeeting(plain, "Orders", undefined, "openai_compatible", "m", BASE, "debate");
    assert.equal(await endMeeting(meetingId, true), block);
    assert.ok(calls[1].body.messages.at(-1).content.includes("<DISSENT>"));
    const [draft] = sessionDissentDrafts(readArchivedSession(meetingId));
    assert.equal(draft.by, plain);
    assert.deepEqual(draft.source, { kind: "debate", ref: meetingId });
  });

  test("closing without a requested summary makes no additional calls or drafts", async (t) => {
    const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: block } }] }));
    const { collaborationId } = await startCollaboration([sample, plain], "Orders", { ...opts, mode: "debate" });
    const result = await endCollaboration(collaborationId);
    assert.equal(calls.length, 1);
    assert.equal(result.dissentSummaries, undefined);
    assert.deepEqual(sessionDissentDrafts(readArchivedSession(collaborationId)), []);
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
