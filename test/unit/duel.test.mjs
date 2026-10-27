import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runDuel, parseDuelVerdicts, resolveSeatsLocal } from "../../dist/table/duel.js";
import { getPrototypeFiles, replayDuel } from "../../dist/table/replay.js";
import { fanout } from "../../dist/table/events.js";
import { ROUNDTABLE_HOME, DEFAULT_MODELS, AGENTS_DIR, PARALLEL_TURNS } from "../../dist/config.js";
import { readTableLines } from "../../dist/usage/table.js";
import { abortSession } from "../../dist/usage/session-scope.js";
import { json, stubFetch } from "./helpers.mjs";

const options = { stages: 1, topic: "60-second budgeting game", teamA: ["designer", "builder"], teamB: ["marketer", "skeptic"], judges: ["cfo", "safety-reviewer"] };
const seats = [
  ["designer", "A", "designer"], ["builder", "A", "builder"],
  ["marketer", "B", "designer"], ["skeptic", "B", "builder"],
  ["cfo", "judge", "judge"], ["safety-reviewer", "judge", "judge"],
].map(([name, team, role]) => ({ id: name, name, team, role, provider: "openai_compatible", model: "claude-sonnet-5-5", prompt: `You are the ${name}.` }));
const game = team => `<prototype kind="web" title="Budget ${team}" entry="index.html"><file path="index.html"><!doctype html><html lang="en"><title>Budget ${team}</title><button id="save">Save</button><output id="total">0</output><script>let n=0;document.getElementById('save').onclick=()=>document.getElementById('total').textContent=++n;</script></html></file></prototype>`;
const dissent = "We should test the budget lesson.\n<DISSENT>\nclaim: Saving alone may not teach tradeoffs\npredicted_failure: Players may skip necessary spending\n</DISSENT>";

function setup(t, script = {}) {
  const originalBase = process.env.OPENAI_COMPATIBLE_BASE_URL;
  process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1/v1";
  t.after(() => { if (originalBase === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL; else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBase; });
  const attempts = { A: 0, B: 0 };
  let active = 0;
  let peak = 0;
  const calls = stubFetch(t, async (_url, init) => {
    active++;
    peak = Math.max(peak, active);
    try {
      const request = JSON.parse(init.body);
      const prompt = request.messages.at(-1).content;
      const team = /Team ([AB])/.exec(prompt)?.[1];
      let content;
      if (prompt.startsWith("R1 CONCEPT")) {
        if (script.waitForDeadline) await new Promise((_resolve, reject) => {
          const abort = () => reject(init.signal.reason);
          if (init.signal.aborted) return abort();
          init.signal.addEventListener("abort", abort, { once: true });
          script.onConceptPending?.();
        });
        if (script.lengthOnce && team === "A" && !script.lengthDone) {
          script.lengthDone = true;
          return json(200, { choices: [{ message: { content: "", reasoning_content: "thinking..." }, finish_reason: "length" }], model: request.model, usage: { prompt_tokens: 100, completion_tokens: 2048 } });
        }
        content = `Concept for ${team}.`;
      } else if (prompt.startsWith("R1b BUILD")) {
        attempts[team]++;
        content = script.build?.(team, attempts[team], prompt) ?? game(team);
      } else if (prompt.startsWith("R2 JUDGE")) {
        if (script.failedJudge) throw new Error("Synthetic provider failure");
        content = script.verdicts ?? "VERDICT A: APPROVE — Clear choices\nVERDICT B: REVISE — Add feedback";
      } else if (prompt.startsWith("R4 CLOSING")) content = team === "B" ? dissent : "Clear choices help players learn.";
      else throw new Error("Unexpected duel prompt");
      return json(200, { choices: [{ message: { content }, finish_reason: "stop" }], model: request.model,
        usage: { prompt_tokens: 100, completion_tokens: 30 } });
    } finally { active--; }
  });
  return { calls, attempts, peak: () => peak };
}

async function run(t, script = {}, overrides = {}, signal = new AbortController().signal) {
  const fetch = setup(t, script);
  const events = [];
  const files = [];
  const observer = fanout({ onEvent(event) { events.push(event); if (event.type === "prototype" && event.ok) files.push(getPrototypeFiles(event)); } }, { onEvent() { throw new Error("Renderer failed"); } });
  const result = await runDuel({ ...options, ...overrides }, observer, signal, { resolveSeats: () => seats });
  return { ...fetch, result, events, files };
}

test("duel streams both games, judge assessments, dissent, measured usage, and a private archive", async t => {
  const { events, result, calls, files, peak } = await run(t);
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1).type, "end");
  assert.equal(events.at(-2).type, "usage");
  assert.equal(result.winner, "A");
  assert.deepEqual(result.tally, { A: 2, B: 0 });
  assert.equal(events.filter(e => e.type === "prototype" && e.ok).length, 2);
  assert.equal(events.filter(e => e.type === "assessment").length, 4);
  assert.match(events.find(e => e.type === "dissent").text, /Players may skip necessary spending/);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(c => c.signal instanceof AbortSignal));
  assert.ok(peak() <= PARALLEL_TURNS);
  assert.ok(files.every(f => f.length === 1 && f[0].content.includes("<script>")));
  const usage = events.at(-2);
  assert.equal(usage.perSeat.reduce((n, s) => n + s.inputTokens, 0), 800);
  assert.equal(usage.perSeat.reduce((n, s) => n + s.outputTokens, 0), 240);
  assert.ok(Math.abs(usage.totalCostUsd - 0.004) < 1e-12);
  const archive = JSON.parse(await readFile(result.archivePath, "utf8"));
  assert.deepEqual(archive.events, events);
  assert.equal(archive.prototypes.length, 2);
  assert.equal((await stat(result.archivePath)).mode & 0o777, 0o600);
  assert.ok(!("prompt" in archive.events[0].seats[0]));
  assert.ok(usage.perSeat.find(s => s.seatId === "cfo").inputTokens > 0);
  const ledger = readTableLines([new Date().toISOString().slice(0, 10)], ROUNDTABLE_HOME).filter(line => line.session === result.id);
  assert.equal(ledger.length, calls.length);
  assert.ok(events.find(e => e.type === "usage").perSeat.some(s => s.inputTokens > 0));
});

test("a non-build turn that ran out of tokens thinking is retried once at double the ceiling", async t => {
  const { calls, events } = await run(t, { lengthOnce: true });
  const concepts = calls.filter(c => c.body.messages.at(-1).content.startsWith("R1 CONCEPT") && /Team A/.test(c.body.messages.at(-1).content));
  assert.equal(concepts.length, 2);
  assert.equal(concepts[0].body.max_tokens, 8192);
  assert.equal(concepts[1].body.max_tokens, 16_384);
  assert.ok(calls.filter(c => c.body.messages.at(-1).content.startsWith("R1b BUILD")).every(c => c.body.max_tokens === 16_384));
  assert.ok(!events.some(e => e.type === "turn" && /did not complete/.test(e.text)));
  assert.match(events.find(e => e.type === "turn" && e.round === "R1" && e.seat.team === "A").text, /Concept for A/);
});

test("a model with no known price reports its tokens as unpriced, not $0", async t => {
  setup(t);
  const events = [];
  const unpriced = seats.map(s => ({ ...s, provider: "together", model: "zai-org/GLM-5.3" }));
  process.env.TOGETHER_API_KEY = "k";
  t.after(() => { delete process.env.TOGETHER_API_KEY; });
  await runDuel(options, { onEvent(e) { events.push(e); } }, new AbortController().signal, { resolveSeats: () => unpriced });
  const usage = events.at(-2);
  assert.equal(usage.totalCostUsd, 0);
  assert.equal(usage.totalUnpricedTokens, 1040);
  assert.ok(usage.perSeat.every(s => s.costUsd === 0 && s.unpricedTokens > 0));
});

test("bad prototype gets one retry with its validation error", async t => {
  const { attempts, calls, events } = await run(t, { build: (team, attempt) => team === "A" && attempt === 1 ? "No prototype" : game(team) });
  assert.equal(attempts.A, 2);
  assert.equal(attempts.B, 1);
  assert.ok(calls.some(c => c.body.messages.at(-1).content.includes("Missing prototype block.")));
  assert.equal(events.filter(e => e.type === "prototype" && e.ok).length, 2);
});

test("inline JavaScript comments do not count as external URLs", async t => {
  const { events, attempts } = await run(t, { build: team => game(team).replace("<script>", "<script>\n// Keep all game logic in this file; no https://example.com/lib.js needed.\n") });
  assert.equal(attempts.A, 1);
  assert.equal(attempts.B, 1);
  assert.equal(events.filter(e => e.type === "prototype" && e.ok).length, 2);
});

test("oversized and external prototypes fail validation; a script-free page is fine", async t => {
  for (const invalid of [game("A").replace("<!doctype html>", "<!doctype html>" + "x".repeat(42 * 1024)), game("A").replace("<button", '<img src="https://invalid.example/pixel"><button')]) {
    await t.test("rejects invalid source", async child => {
      const { events, attempts } = await run(child, { build: team => team === "A" ? invalid : game(team) });
      assert.equal(attempts.A, 2);
      assert.equal(events.find(e => e.type === "prototype" && e.team === "A").ok, false);
    });
  }
});

test("a web artifact without JavaScript is accepted", async t => {
  const plain = team => game(team).replace(/<script>[\s\S]*?<\/script>/, "");
  const { events, attempts } = await run(t, { build: plain });
  assert.equal(attempts.A, 1);
  assert.equal(events.filter(e => e.type === "prototype" && e.ok).length, 2);
});

test("a failed team gets a placeholder and automatic REJECTs", async t => {
  const { events, result, attempts } = await run(t, { build: team => team === "A" ? "invalid" : game(team) });
  assert.equal(attempts.A, 2);
  assert.equal(events.find(e => e.type === "prototype" && e.team === "A").ok, false);
  assert.ok(events.filter(e => e.type === "assessment" && e.team === "A").every(e => e.verdict === "REJECT"));
  assert.equal(result.winner, "B");
});

test("an equal tally stays a tie", async t => {
  const { result } = await run(t, { verdicts: "VERDICT A: APPROVE — Works\nVERDICT B: APPROVE — Works" });
  assert.equal(result.winner, "tie");
  assert.deepEqual(result.tally, { A: 2, B: 2 });
});

test("failed judges cast no verdict", async t => {
  const { result, events } = await run(t, { failedJudge: true });
  assert.equal(result.winner, "none");
  assert.equal(events.filter(e => e.type === "assessment").length, 0);
});

test("optional revision runs only for a team needing changes and preserves the judging tally", async t => {
  const { events, result, attempts } = await run(t, {}, { rounds: 2 });
  assert.equal(attempts.A, 1);
  assert.equal(attempts.B, 2);
  assert.equal(events.filter(e => e.type === "prototype" && e.team === "B").length, 2);
  assert.equal(events.filter(e => e.type === "turn" && e.round === "R3").length, 1);
  assert.equal(result.winner, "A");
  const versions = [];
  await replayDuel(result.archivePath, { onEvent(event) { if (event.type === "prototype") versions.push(getPrototypeFiles(event)); } }, { speed: 100000 });
  assert.equal(versions.length, 3);
  assert.ok(versions.every(files => files[0].content.includes("<script>")));
});

test("failed revision preserves the earlier playable game", async t => {
  const { events, result, attempts } = await run(t, { build: (team, attempt) => team === "B" && attempt > 1 ? "invalid revision" : game(team) }, { rounds: 2 });
  assert.equal(attempts.B, 3);
  assert.equal(events.filter(e => e.type === "prototype" && e.team === "B").length, 1);
  const archive = JSON.parse(await readFile(result.archivePath, "utf8"));
  assert.equal(archive.prototypes.filter(p => p.team === "B").length, 1);
});

test("max-seconds aborts in-flight work and skips ahead", async t => {
  // Filesystem setup may outlast a short real deadline under load. Advance time only
  // once a concept request is pending so this case always exercises in-flight aborts.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const { promise: conceptPending, resolve: onConceptPending } = Promise.withResolvers();
  const running = run(t, { waitForDeadline: true, onConceptPending }, { maxSeconds: 1 });
  await conceptPending;
  t.mock.timers.tick(1000);
  const { events, calls, result } = await running;
  const concepts = calls.filter(c => c.body.messages.at(-1).content.startsWith("R1 CONCEPT"));
  assert.ok(concepts.length > 0);
  assert.ok(concepts.every(c => c.signal.aborted));
  const closings = calls.filter(c => c.body.messages.at(-1).content.startsWith("R4 CLOSING"));
  // Nothing was built, so there is nothing to close on.
  assert.equal(closings.length, 0);
  assert.ok(!events.some(e => e.type === "turn" && e.round === "R4"));
  assert.ok(!events.some(e => e.type === "turn" && e.round === "R2"));
  assert.equal(result.aborted, false);
  assert.equal(result.winner, "none");
});

test("max-seconds can expire before provider work starts and and skips closing", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const { calls } = setup(t, { waitForDeadline: true });
  const events = [];
  const result = await runDuel({ ...options, maxSeconds: 1 }, { onEvent(event) {
    events.push(event);
    if (event.type === "start") t.mock.timers.tick(1000);
  } }, new AbortController().signal, { resolveSeats: () => seats });
  assert.equal(calls.length, 0, "no closings when neither team submitted");
  assert.equal(events.filter(e => e.type === "prototype" && !e.ok).length, 2);
  assert.equal(events.at(-1).type, "end");
  assert.equal(result.aborted, false);
  assert.equal(result.winner, "none");
});

test("per-call timeouts settle turns and still archive", async t => {
  const { events, result } = await run(t, { waitForDeadline: true }, { turnTimeoutMs: 5 });
  assert.equal(result.aborted, false);
  assert.ok(events.some(e => e.type === "turn" && /^This turn did not complete \(.+\)\.$/.test(e.text)));
  assert.equal(events.at(-1).type, "end");
});

test("an already aborted duel checkpoints without an end event or calls", async t => {
  const controller = new AbortController(); controller.abort();
  const { calls, result, events } = await run(t, {}, {}, controller.signal);
  assert.equal(calls.length, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.resumable, true);
  assert.ok(!events.some(e => e.type === "end"));
  assert.equal(events.at(-1).action, "stopped");
});

test("session-level aborts cancel the duel through the shared meter", async t => {
  const { calls } = setup(t);
  const events = [];
  const result = await runDuel(options, { onEvent(event) {
    events.push(event);
    if (event.type === "start") abortSession(event.id, "Synthetic session stop");
  } }, new AbortController().signal, { resolveSeats: () => seats });
  assert.equal(calls.length, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.winner, "none");
  assert.equal(result.resumable, true);
  assert.ok(!events.some(e => e.type === "end"));
});

test("verdict parser fails closed for missing, quoted, fenced, or ambiguous verdicts", () => {
  assert.equal(parseDuelVerdicts("VERDICT A: MAYBE — hmm").A.verdict, "UNCLEAR");
  assert.equal(parseDuelVerdicts("```\nVERDICT A: APPROVE — quoted\n```").A.verdict, "UNCLEAR");
  assert.equal(parseDuelVerdicts("VERDICT A: APPROVE — yes\nVERDICT A: REJECT — no").A.verdict, "UNCLEAR");
});

test("local seat resolver loads generic personas and applies explicit model overrides", async t => {
  await mkdir(AGENTS_DIR, { recursive: true });
  for (const name of options.teamA.concat(options.teamB, options.judges)) await writeFile(join(AGENTS_DIR, `${name}.md`), `---\nname: ${name}\n---\nYou are the ${name}.\n`);
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fixture-key";
  t.after(() => { if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey; });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Seat resolution must not probe providers"); });
  const resolved = await resolveSeatsLocal({ ...options, agentsDir: AGENTS_DIR, seats: { designer: { agent: "designer", provider: "openai_compatible", model: "custom-model" } } });
  assert.equal(resolved[0].model, "custom-model");
  assert.equal(resolved[0].provider, "openai_compatible");
  assert.equal(resolved[1].model, DEFAULT_MODELS.anthropic);
  assert.equal(resolved[0].team, "A");
  assert.match(resolved[0].prompt, /You are the designer/);
});

test("namespace URLs and prose do not count as external references; real fetches do", async t => {
  const svg = team => game(team).replace("<button", '<svg xmlns="http://www.w3.org/2000/svg"></svg><p>fetch (the coin) quickly</p><button').replace("let n=0;", 'let n=0;document.createElementNS("http://www.w3.org/2000/svg","g");');
  const ok = await run(t, { build: svg });
  assert.equal(ok.attempts.A, 1);
  assert.equal(ok.events.filter(e => e.type === "prototype" && e.ok).length, 2);
  const bad = await run(t, { build: team => team === "A" ? game(team).replace("let n=0;", "fetch('x');") : game(team) });
  assert.equal(bad.attempts.A, 2);
});

test("build turns never carry source; tolerant verdicts, preference tie-break and no-verdict", async t => {
  const { events } = await run(t);
  const builds = events.filter(e => e.type === "turn" && e.round === "R1b");
  assert.equal(builds.length, 2);
  assert.ok(builds.every(e => /^Built index\.html \(\d/.test(e.text) && !e.text.includes("<")));
  assert.deepEqual(parseDuelVerdicts("**VERDICT A:** APPROVE\n> - verdict b - Reject: weak").A, { verdict: "APPROVE", reason: "No reason given." });
  assert.equal(parseDuelVerdicts("> - verdict b - Reject: weak").B.verdict, "REJECT");
  const tie = await run(t, { verdicts: "VERDICT A: APPROVE — ok\nVERDICT B: APPROVE — ok\nPREFER: B" });
  assert.equal(tie.result.winner, "B");
  const none = await run(t, { verdicts: "no verdict lines at all" });
  assert.equal(none.result.winner, "none");
});

test("configured secrets and local paths never reach events or the archive", async t => {
  const secret = "sk-ant-api03-ZZZZ-hardening-fixture-0123456789";
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = secret;
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  const { result, events } = await run(t, { verdicts: `VERDICT A: APPROVE — leaked ${secret}\nVERDICT B: REVISE — also ${secret}`, build: team => game(team).replace("let n=0;", `let n=0;/* ${secret} */`) });
  assert.ok(!JSON.stringify(events).includes(secret));
  const archive = await readFile(result.archivePath, "utf8");
  assert.ok(!archive.includes(secret));
  assert.ok(events.at(-1).archivePath.startsWith("duels/"));
});

test("per-provider caps keep build and retry token limits within what each provider accepts", async t => {
  const { turnTokens } = await import("../../dist/table/duel.js");
  assert.equal(turnTokens("replicate", "R1b"), 16_384);
  assert.equal(turnTokens("replicate", "R1"), 8192);
  assert.equal(turnTokens("anthropic", "R1b"), 32_000);
  assert.equal(turnTokens("openai", "R3"), 32_768);
  assert.equal(turnTokens("ollama", "R1"), 8192);
  process.env.TOGETHER_API_KEY = "k";
  t.after(() => { delete process.env.TOGETHER_API_KEY; });
  const together = seats.map(s => ({ ...s, provider: "together", model: "zai-org/GLM-5.3" }));
  const calls = stubFetch(t, async (_url, init) => {
    const request = JSON.parse(init.body);
    return json(200, { choices: [{ message: { content: game("A") }, finish_reason: "stop" }], model: request.model, usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  await runDuel(options, { onEvent() {} }, new AbortController().signal, { resolveSeats: () => together });
  assert.ok(calls.length > 0 && calls.every(c => c.body.max_tokens <= 16_384));
  assert.ok(calls.some(c => c.body.max_tokens === 16_384));
});

test("page checks are recorded; a throwing page uses the single builder retry and judges see the summary and version", async t => {
  const scripted = setup(t);
  const events = [];
  const attempts = { A: 0, B: 0 };
  const { getPrototypeScreenshot } = await import("../../dist/table/replay.js");
  const checker = async url => {
    const team = /\/p\/([AB])\//.exec(url)[1];
    const thrown = ++attempts[team] === 1 && team === "A";
    return { ok: !thrown, loaded: true, consoleErrors: [], exceptions: thrown ? ["TypeError: broken button"] : [], failedRequests: 0, screenshot: Buffer.from("png") };
  };
  const startRoom = async () => ({ url: "http://127.0.0.1:1/capability/", observer: { onEvent() {} }, close: async () => {} });
  const result = await runDuel(options, { onEvent(e) { events.push(e); } }, new AbortController().signal, { resolveSeats: () => seats, checkPage: checker, startRoom });
  assert.equal(scripted.attempts.A, 2); assert.equal(scripted.attempts.B, 1);
  const prototypes = events.filter(e => e.type === "prototype" && e.team === "A");
  assert.equal(prototypes.length, 2); assert.deepEqual(prototypes.map(p => p.version), [1, 2]);
  assert.deepEqual(prototypes[0].check.exceptions, ["TypeError: broken button"]);
  assert.equal(getPrototypeScreenshot(prototypes[0]).toString(), "png");
  const prompts = scripted.calls.map(call => JSON.parse(call.init.body).messages.at(-1).content);
  assert.ok(prompts.some(p => p.startsWith("R1b BUILD") && p.includes("Page check: threw TypeError: broken button")));
  assert.ok(prompts.some(p => p.startsWith("R2 JUDGE") && p.includes("Page check: loaded; 0 console errors") && p.includes("Version v2")));
  assert.equal(events.find(e => e.type === "assessment" && e.team === "A").version, 2);
  const replayed = [];
  await replayDuel(result.archivePath, { onEvent(e) { replayed.push(e); } }, { speed: 100000 });
  assert.deepEqual(replayed.filter(e => e.type === "prototype").map(e => e.check), events.filter(e => e.type === "prototype").map(e => e.check));
  assert.ok(replayed.filter(e => e.type === "prototype").every(e => getPrototypeScreenshot(e) === undefined));
});

test("a revision whose page still fails gives way to the last version that worked", async t => {
  const scripted = setup(t, { build: (team, attempt) => team === "B" && attempt > 1 ? game(team).replace("Save", "Revised") : game(team) });
  const events = [];
  const checker = async url => {
    const broken = /\/p\/B\//.test(url) && events.filter(e => e.type === "prototype" && e.team === "B").length > 0;
    return { ok: !broken, loaded: true, consoleErrors: [], exceptions: broken ? ["TypeError: revision broke"] : [], failedRequests: 0 };
  };
  const startRoom = async () => ({ url: "http://127.0.0.1:1/capability/", observer: { onEvent() {} }, close: async () => {} });
  const result = await runDuel({ ...options, rounds: 2 }, { onEvent(e) { events.push(e); } }, new AbortController().signal, { resolveSeats: () => seats, checkPage: checker, startRoom });
  assert.equal(scripted.attempts.B, 3);
  const b = events.filter(e => e.type === "prototype" && e.team === "B");
  assert.deepEqual(b.map(p => p.version), [1, 2, 3]);
  assert.deepEqual(b.map(p => p.check.exceptions.length > 0), [false, true, true]);
  const { pageCheckFailed } = await import("../../dist/prototypes/page-check.js");
  assert.equal(pageCheckFailed({ loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "no browser" }), false);
  assert.equal(pageCheckFailed(undefined), false);
  const { loadDuelFocus } = await import("../../dist/sessions/duel-focus.js");
  const id = result.archivePath.split("/").at(-1).replace(/\.json$/, "");
  const brief = loadDuelFocus(id).brief;
  assert.ok(brief.includes("Save") && !brief.includes("Revised"));
});

test("--no-page-check and MCP page_check opt out; old archives still replay without checks", async t => {
  const { parseTableArgs } = await import("../../dist/cli-table.js");
  const { START_DUEL_SCHEMA } = await import("../../dist/tools/duel.js");
  const parsed = parseTableArgs("duel", ["A brief", "--team-a", "a", "--team-b", "b", "--judges", "j", "--no-page-check"]);
  assert.equal(parsed.options.pageCheck, false); assert.equal(START_DUEL_SCHEMA.properties.page_check.type, "boolean");
  setup(t);
  const events = [];
  await runDuel({ ...options, pageCheck: false }, { onEvent(e) { events.push(e); } }, new AbortController().signal,
    { resolveSeats: () => seats, checkPage: async () => { throw new Error("checker must not run"); }, startRoom: async () => { throw new Error("room must not start"); } });
  assert.ok(events.filter(e => e.type === "prototype").every(e => e.check.reason === "disabled"));
  const replayed = [];
  await replayDuel(new URL("../fixtures/duel-v1.json", import.meta.url).pathname, { onEvent(e) { replayed.push(e); } }, { speed: 100000 });
  assert.ok(replayed.filter(e => e.type === "prototype").every(e => e.check === undefined));
});
