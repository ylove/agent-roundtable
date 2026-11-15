import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setConnectorConfig } from "../../dist/user-config.js";
import { startCollaboration, endCollaboration } from "../../dist/sessions/collaborations.js";
import { startMeeting, continueMeeting, endMeeting } from "../../dist/sessions/meetings.js";
import { startUltraplan, endUltraplan } from "../../dist/sessions/ultraplan.js";
import { runCastingCall } from "../../dist/casting/casting.js";
import { assertSeatConnectors, parseSeatConnectorsFlag } from "../../dist/table/seat-connectors.js";
import { parseTableArgs } from "../../dist/cli-table.js";
import { parseCastArgs } from "../../dist/cli-cast.js";
import { callLLMWithTools, supportsTools } from "../../dist/providers/index.js";
import { deliberationTools } from "../../dist/tools/deliberation.js";
import { castingCallTool, CASTING_CALL_SCHEMA } from "../../dist/tools/casting.js";
import { startDuelTool } from "../../dist/tools/duel.js";
import { json, stubFetch } from "./helpers.mjs";

const SERVER = resolve(fileURLToPath(new URL("../fixtures/connectors/seat-server.mjs", import.meta.url)));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async pid => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100)); return !alive(pid); };

function env(t, { openai = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-seatfollow-")));
  const saved = { key: process.env.OPENAI_API_KEY, tok: process.env.SEAT_FOLLOW_TOKEN };
  if (openai) process.env.OPENAI_API_KEY = "sk-test";
  process.env.SEAT_FOLLOW_TOKEN = "follow-secret-value-123";
  t.after(() => {
    for (const [k, v] of [["OPENAI_API_KEY", saved.key], ["SEAT_FOLLOW_TOKEN", saved.tok]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const pids = join(dir, "pids.log");
  for (const name of ["desk", "other"]) {
    setConnectorConfig(name, { command: process.execPath, args: [SERVER], env: { SEAT_TOKEN: "secret://env/SEAT_FOLLOW_TOKEN", SEAT_FIXTURE_PID: pids } });
  }
  const agents = process.env.ROUNDTABLE_AGENTS_DIR;
  mkdirSync(agents, { recursive: true });
  for (const id of ["ada", "bo"]) writeFileSync(join(agents, `${id}.md`), `You are ${id}.\n`);
  return { dir, pids };
}
const pidsOf = file => readFileSync(file, "utf8").trim().split("\n").map(Number);
const toolNames = req => (req.tools ?? []).map(t => t.function.name);
const systemOf = req => req.messages.find(m => m.role === "system")?.content ?? "";
const hasToolResult = req => req.messages.some(m => m.role === "tool");
const text = content => json(200, { model: "m", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
const call = name => json(200, { model: "m", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: '{"q":"x"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });

test("assertSeatConnectors validates names against the session's list and the seats", () => {
  const session = ["desk", "other"];
  assert.equal(assertSeatConnectors(undefined, session), undefined);
  assert.deepEqual(assertSeatConnectors({ Ada: ["desk"], bo: [] }, session, ["ada", "bo"]), { ada: ["desk"], bo: [] });
  assert.throws(() => assertSeatConnectors({ ada: ["figma"] }, session), /not in connectors/);
  assert.throws(() => assertSeatConnectors({ ada: ["desk"] }, []), /requires connectors/);
  assert.throws(() => assertSeatConnectors({ zed: ["desk"] }, session, ["ada", "bo"]), /not at this table/);
  assert.throws(() => assertSeatConnectors({ ada: "desk" }, session), /list of connector names/);
  assert.throws(() => assertSeatConnectors([], session), /map seat names/);
});

test("--seat-connectors parses seat=a+b pairs", () => {
  assert.deepEqual(parseSeatConnectorsFlag("ada=figma,bob=jira+figma,ada=jira"), { ada: ["figma", "jira"], bob: ["jira", "figma"] });
  for (const bad of ["ada", "ada=", "=figma", "ada=Figma", "ada=figma,,bob=jira"]) assert.throws(() => parseSeatConnectorsFlag(bad), /seat=connector/);
});

test("the table and cast CLIs parse and validate --seat-connectors", t => {
  env(t);
  const parsed = parseTableArgs("debate", ["topic", "--agents", "ada,bo", "--connectors", "desk,other", "--seat-connectors", "ada=desk,bo=other+desk"]);
  assert.deepEqual(parsed.options.seatConnectors, { ada: ["desk"], bo: ["other", "desk"] });
  assert.throws(() => parseTableArgs("debate", ["topic", "--agents", "ada,bo", "--seat-connectors", "ada=desk"]), /requires --connectors/);
  assert.throws(() => parseTableArgs("debate", ["topic", "--agents", "ada,bo", "--connectors", "desk", "--seat-connectors", "ada=other"]), /not in connectors/);
  assert.throws(() => parseTableArgs("debate", ["topic", "--agents", "ada,bo", "--connectors", "desk", "--seat-connectors", "zed=desk"]), /not at this table/);
  const duel = parseTableArgs("duel", ["topic", "--team-a", "a1", "--team-b", "b1", "--judges", "j1", "--connectors", "desk", "--seat-connectors", "j1=desk"]);
  assert.deepEqual(duel.options.seatConnectors, { j1: ["desk"] });
  const cast = parseCastArgs(["brief", "--connectors", "desk,other", "--seat-connectors", "ada=desk"]);
  assert.deepEqual(cast.options.connectors, ["desk", "other"]);
  assert.deepEqual(cast.options.seatConnectors, { ada: ["desk"] });
  assert.throws(() => parseCastArgs(["brief", "--seat-connectors", "ada=desk"]), /requires --connectors/);
});

test("a collaboration limits a seat to its listed connectors; unlisted seats get all", async t => {
  const { pids } = env(t);
  const sent = [];
  stubFetch(t, (_url, init) => { const req = JSON.parse(init.body); sent.push(req); return text("my view"); });
  const started = await startCollaboration(["ada", "bo"], "topic", { provider: "openai", model: "m", connectors: ["desk", "other"], seatConnectors: { ada: ["desk"] }, maxRounds: 1, autoRun: true, runRounds: 1 });
  const ended = endCollaboration(started.collaborationId, false);
  const ada = sent.find(r => /You are ada/.test(systemOf(r))), bo = sent.find(r => /You are bo/.test(systemOf(r)));
  await ended;
  assert.deepEqual(toolNames(ada).sort(), ["desk__lookup", "desk__env_names", "desk__leak", "desk__big", "desk__boom"].sort());
  assert.ok(toolNames(bo).includes("other__lookup") && toolNames(bo).includes("desk__lookup"));
  assert.ok((await Promise.all(pidsOf(pids).map(gone))).every(Boolean));
});

test("a collaboration refuses a bad per-seat map before any provider call", async t => {
  env(t);
  const calls = stubFetch(t, () => text("no"));
  await assert.rejects(startCollaboration(["ada", "bo"], "t", { provider: "openai", model: "m", connectors: ["desk"], seatConnectors: { ada: ["other"] } }), /not in connectors/);
  await assert.rejects(startCollaboration(["ada", "bo"], "t", { provider: "openai", model: "m", connectors: ["desk"], seatConnectors: { zed: ["desk"] } }), /not at this table/);
  assert.equal(calls.length, 0);
});

test("a meeting gives its agent connectors on every turn and closes the server when it ends", async t => {
  const { pids } = env(t);
  const sent = [];
  stubFetch(t, (_url, init) => {
    const req = JSON.parse(init.body);
    sent.push(req);
    return req.tools && !hasToolResult(req) && sent.filter(r => r.tools && !hasToolResult(r)).length === 1 ? call("desk__lookup") : text("meeting reply");
  });
  const started = await startMeeting("ada", "agenda", undefined, "openai", "m", undefined, "standard", undefined, false, false, true, { connectors: ["desk"] });
  assert.equal(started.response, "meeting reply");
  assert.ok(hasToolResult(sent[1]));
  const reply = await continueMeeting(started.meetingId, "go on");
  assert.equal(reply, "meeting reply");
  assert.ok(toolNames(sent.at(-1)).includes("desk__lookup"));
  const [pid] = pidsOf(pids);
  assert.ok(alive(pid));
  const ended = await endMeeting(started.meetingId, false);
  assert.match(ended, /Connector use:\n- ada used desk__lookup \(ok, \d+ bytes; arguments: q\)/);
  assert.ok(await gone(pid), "the connector server is closed when the meeting ends");
});

test("a meeting refuses an unknown connector, or a per-seat map for another seat, before any provider call", async t => {
  env(t);
  const calls = stubFetch(t, () => text("no"));
  await assert.rejects(startMeeting("ada", "a", undefined, "openai", "m", undefined, "standard", undefined, false, false, true, { connectors: ["missing"] }), /Unknown connector: missing/);
  await assert.rejects(startMeeting("ada", "a", undefined, "openai", "m", undefined, "standard", undefined, false, false, true, { connectors: ["desk"], seatConnectors: { bo: ["desk"] } }), /not at this table/);
  assert.equal(calls.length, 0);
});

test("a failed first turn closes the meeting's connector server", async t => {
  const { pids } = env(t);
  stubFetch(t, () => json(400, { error: { message: "bad" } }));
  await assert.rejects(startMeeting("ada", "a", undefined, "openai", "m", undefined, "standard", undefined, false, false, true, { connectors: ["desk"] }));
  assert.ok(await gone(pidsOf(pids)[0]));
});

test("an ultraplan gives its agents connectors, honours per-seat limits and closes on end", async t => {
  const { pids } = env(t);
  const sent = [];
  let used = false;
  stubFetch(t, (_url, init) => {
    const req = JSON.parse(init.body);
    sent.push(req);
    if (req.tools && !hasToolResult(req) && /You are ada/.test(systemOf(req)) && !used) { used = true; return call("desk__lookup"); }
    return text("my input");
  });
  const started = await startUltraplan(["ada", "bo"], "plan it", { provider: "openai", model: "m", connectors: ["desk", "other"], seatConnectors: { bo: ["other"] } });
  assert.equal(started.status, "awaiting_plan");
  const bo = sent.find(r => /You are bo/.test(systemOf(r)));
  assert.deepEqual(toolNames(bo).filter(n => !n.startsWith("other__")), []);
  const [pid] = pidsOf(pids);
  assert.ok(alive(pid));
  const ended = await endUltraplan(started.ultraplanId);
  assert.match(ended.toolUses[0], /^ada used desk__lookup/);
  assert.ok((await Promise.all(pidsOf(pids).map(gone))).every(Boolean));
});

test("an ultraplan refuses an unknown connector before any provider call", async t => {
  env(t);
  const calls = stubFetch(t, () => text("no"));
  await assert.rejects(startUltraplan(["ada"], "t", { provider: "openai", model: "m", connectors: ["missing"] }), /Unknown connector: missing/);
  assert.equal(calls.length, 0);
});

test("a casting call gives personas connectors, notes each call and closes the server", async t => {
  const { pids } = env(t);
  const calls = stubFetch(t, (_url, init) => {
    const req = JSON.parse(init.body);
    return req.tools && !hasToolResult(req) && /You are ada/.test(systemOf(req)) ? call("desk__lookup") : text("audition text");
  });
  const events = [];
  const report = await runCastingCall({ brief: "a brief", agents: ["ada", "bo"], examine: false, provider: "openai", model: "m", connectors: ["desk"], seatConnectors: { bo: [] } }, { onEvent: e => { events.push(e); } }, new AbortController().signal);
  assert.ok(report.id);
  const notes = events.filter(e => e.type === "turn" && e.round === "tool");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^ada used desk__lookup/);
  // bo is limited to no connectors: its requests carry no tools.
  assert.ok(calls.filter(c => /You are bo/.test(systemOf(c.body))).every(c => !c.body.tools));
  assert.ok(await gone(pidsOf(pids)[0]));
});

test("a casting call refuses unknown connectors and dry-run connectors before anything starts", async t => {
  env(t);
  const calls = stubFetch(t, () => text("no"));
  const base = { brief: "b", agents: ["ada", "bo"], provider: "openai", model: "m" };
  await assert.rejects(runCastingCall({ ...base, connectors: ["missing"] }, { onEvent() {} }, new AbortController().signal), /Unknown connector: missing/);
  await assert.rejects(runCastingCall({ ...base, dryRun: true, connectors: ["desk"] }, { onEvent() {} }, new AbortController().signal), /not available with dry-run/);
  await assert.rejects(castingCallTool({ brief: "b", agents: ["ada", "bo"], connectors: ["missing"] }), /Unknown connector: missing/);
  assert.equal(calls.length, 0);
  assert.ok(CASTING_CALL_SCHEMA.properties.connectors && CASTING_CALL_SCHEMA.properties.seat_connectors);
});

test("start_duel validates seat_connectors before seats are prepared", async t => {
  env(t);
  const calls = stubFetch(t, () => text("no"));
  const base = { topic: "t", team_a: ["ada"], team_b: ["bo"], judges: ["cfo"], connectors: ["desk"] };
  await assert.rejects(startDuelTool({ ...base, seat_connectors: { ada: ["other"] } }), /not in connectors/);
  await assert.rejects(startDuelTool({ ...base, seat_connectors: { zed: ["desk"] } }), /not at this table/);
  assert.equal(calls.length, 0);
});

test("connectors and seat_connectors are on every table start tool that can take them", () => {
  const byName = Object.fromEntries(deliberationTools.map(d => [d.name, d.inputSchema.properties]));
  for (const name of ["start_meeting", "start_collaboration", "start_ultraplan", "start_duel"]) {
    const props = byName[name] ?? {};
    if (name === "start_duel") continue; // checked through START_DUEL_SCHEMA in the duel tool
    assert.ok(props.connectors && props.seat_connectors, `${name} takes connectors and seat_connectors`);
  }
  // The local meeting runs the installed Claude CLI, which owns its own tools.
  assert.ok(!byName.start_local_meeting.connectors && !byName.start_local_meeting.seat_connectors);
});

test("Ollama carries tools on /api/chat and returns tool_calls to the loop", async t => {
  const bodies = [];
  stubFetch(t, (url, init) => {
    if (url.endsWith("/api/tags")) return json(200, { models: [] });
    const req = JSON.parse(init.body);
    bodies.push(req);
    if (!req.messages.some(m => m.role === "tool")) {
      return json(200, { model: "llama", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "desk__lookup", arguments: { q: "x" } } }] }, prompt_eval_count: 4, eval_count: 2 });
    }
    return json(200, { model: "llama", message: { role: "assistant", content: "answer" }, done_reason: "stop", prompt_eval_count: 6, eval_count: 3 });
  });
  assert.equal(supportsTools("ollama"), true);
  const tools = [{ name: "desk__lookup", description: "Look.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
  const seen = [];
  const result = await callLLMWithTools("sys", [{ role: "user", content: "hi" }], { provider: "ollama", model: "llama" }, tools, async (name, input) => { seen.push([name, input]); return { text: "found x" }; });
  assert.equal(result.content, "answer");
  assert.deepEqual(seen, [["desk__lookup", { q: "x" }]]);
  assert.deepEqual(bodies[0].tools, [{ type: "function", function: { name: "desk__lookup", description: "Look.", parameters: tools[0].inputSchema } }]);
  assert.equal(bodies[0].stream, false);
  const tool = bodies[1].messages.find(m => m.role === "tool");
  assert.deepEqual(tool, { role: "tool", tool_name: "desk__lookup", content: "found x" });
  assert.ok(bodies[1].messages.some(m => m.role === "assistant" && m.tool_calls?.length));
  assert.equal(result.usage.inputTokens, 10);
});

test("Ollama without a toolRound sends no tools field", async t => {
  const bodies = [];
  stubFetch(t, (url, init) => {
    if (url.endsWith("/api/tags")) return json(200, { models: [] });
    bodies.push(JSON.parse(init.body));
    return json(200, { model: "llama", message: { role: "assistant", content: "plain" }, done_reason: "stop" });
  });
  const { callLLM } = await import("../../dist/providers/index.js");
  assert.equal(await callLLM("sys", [{ role: "user", content: "hi" }], { provider: "ollama", model: "llama" }), "plain");
  assert.equal(bodies[0].tools, undefined);
});
