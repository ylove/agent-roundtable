import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { json, stubFetch } from "./helpers.mjs";

process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.OPENAI_API_KEY = "sk-test";
process.env.REPLICATE_API_TOKEN = "r8_test";

const { callLLMWithTools, callLLM, supportsTools } = await import("../../dist/providers/index.js");
const { runToolLoop, capBytes, MAX_TOOL_CALLS } = await import("../../dist/providers/tool-loop.js");
const { startSeatConnectors, assertConnectorsKnown, withSeatConnectors, allowedTools } = await import("../../dist/table/seat-connectors.js");
const { callSeat } = await import("../../dist/table/dispatch.js");
const { setConnectorConfig } = await import("../../dist/user-config.js");
const { withUsageSink } = await import("../../dist/providers/usage.js");

const SERVER = resolve(fileURLToPath(new URL("../fixtures/connectors/seat-server.mjs", import.meta.url)));
const tools = [{ name: "desk__lookup", description: "d", inputSchema: { type: "object", properties: {} } }];
const user = [{ role: "user", content: "hi" }];

const anthropicToolUse = (id, input = { q: "a" }, usage = { input_tokens: 10, output_tokens: 5 }) =>
  json(200, { model: "claude-x", stop_reason: "tool_use", content: [{ type: "text", text: "checking" }, { type: "tool_use", id, name: "desk__lookup", input }], usage });
const anthropicText = (text, usage = { input_tokens: 20, output_tokens: 7 }) =>
  json(200, { model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text }], usage });
const openaiCall = (id, args = '{"q":"a"}', usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  json(200, { model: "gpt-x", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name: "desk__lookup", arguments: args } }] } }], usage });
const openaiText = (text, usage = { prompt_tokens: 20, completion_tokens: 7 }) =>
  json(200, { model: "gpt-x", choices: [{ finish_reason: "stop", message: { content: text } }], usage });

describe("tool calling shapes", () => {
  test("anthropic: tools in the request, tool_use then tool_result, usage summed", async (t) => {
    const calls = stubFetch(t, (_u, _i, n) => n === 0 ? anthropicToolUse("tu_1") : anthropicText("done"));
    const seen = [];
    const result = await callLLMWithTools("sys", user, { provider: "anthropic", model: "claude-x" }, tools, async (name, input) => { seen.push([name, input]); return "RESULT"; });
    assert.equal(result.content, "done");
    assert.deepEqual(seen, [["desk__lookup", { q: "a" }]]);
    assert.deepEqual(calls[0].body.tools, [{ name: "desk__lookup", description: "d", input_schema: tools[0].inputSchema }]);
    assert.equal(calls[0].body.tool_choice, undefined);
    const second = calls[1].body.messages;
    assert.equal(second.at(-2).role, "assistant");
    assert.equal(second.at(-2).content[1].type, "tool_use");
    assert.deepEqual(second.at(-1), { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "RESULT" }] });
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12 });
    assert.equal(result.toolCallCount, 1);
  });

  test("openai-compatible: tools / tool_calls / role tool, usage metered per round trip", async (t) => {
    const calls = stubFetch(t, (_u, _i, n) => n === 0 ? openaiCall("call_1") : openaiText("done"));
    const reports = [];
    const result = await withUsageSink(r => reports.push(r), () => callLLMWithTools("sys", user, { provider: "openai", model: "gpt-x" }, tools, async () => "RESULT"));
    assert.equal(result.content, "done");
    assert.deepEqual(calls[0].body.tools, [{ type: "function", function: { name: "desk__lookup", description: "d", parameters: tools[0].inputSchema } }]);
    const msgs = calls[1].body.messages;
    assert.equal(msgs.at(-2).tool_calls[0].id, "call_1");
    assert.deepEqual(msgs.at(-1), { role: "tool", tool_call_id: "call_1", content: "RESULT" });
    assert.equal(reports.length, 2);
    assert.deepEqual(reports.map(r => r.usage), [{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 20, outputTokens: 7 }]);
  });

  test("the call cap: the 7th request forbids tools and extra calls get an error result", async (t) => {
    const calls = stubFetch(t, (_u, _i, n) => n < MAX_TOOL_CALLS ? openaiCall(`c${n}`) : openaiText("enough"));
    let ran = 0;
    const result = await callLLMWithTools("sys", user, { provider: "openai", model: "gpt-x" }, tools, async () => { ran++; return "ok"; });
    assert.equal(ran, 6);
    assert.equal(result.content, "enough");
    assert.equal(calls.length, 7);
    assert.equal(calls[5].body.tool_choice, undefined);
    assert.equal(calls[6].body.tool_choice, "none");
  });

  test("a model that keeps asking for tools after the budget fails the turn", async (t) => {
    stubFetch(t, (_u, _i, n) => anthropicToolUse(`t${n}`));
    await assert.rejects(callLLMWithTools("sys", user, { provider: "anthropic", model: "claude-x" }, tools, async () => "ok"), /tool budget/);
  });

  test("a parallel batch past the cap answers the extras with an error", async () => {
    const turns = [];
    let n = 0;
    const complete = async (round) => {
      turns.push(round);
      if (n++ === 0) return { content: "", model: "m", provider: "openai", toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, name: "x", input: {} })), assistantTurn: { role: "assistant" } };
      return { content: "fin", model: "m", provider: "openai" };
    };
    let ran = 0;
    const r = await runToolLoop(complete, tools, async () => { ran++; return "ok"; }, (calls, results) => results.map((x, i) => ({ id: calls[i].id, ...x })), undefined);
    assert.equal(ran, 6);
    assert.equal(turns[1].forbid, true);
    assert.equal(turns[1].turns.filter(x => x.isError).length, 2);
    assert.equal(r.content, "fin");
  });

  test("a tool error goes back to the model as an error result, scrubbed", async (t) => {
    const calls = stubFetch(t, (_u, _i, n) => n === 0 ? anthropicToolUse("tu_1") : anthropicText("recovered"));
    const result = await callLLMWithTools("sys", user, { provider: "anthropic", model: "claude-x" }, tools, async () => { throw new Error("denied for sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"); });
    assert.equal(result.content, "recovered");
    const block = calls[1].body.messages.at(-1).content[0];
    assert.equal(block.is_error, true);
    assert.match(block.content, /^Tool failed:/);
    assert.ok(!block.content.includes("abcdefghijklmnop"));
  });

  test("a tool that outlives its timeout fails with a timeout result", async (t) => {
    const calls = stubFetch(t, (_u, _i, n) => n === 0 ? openaiCall("c0") : openaiText("ok"));
    const result = await callLLMWithTools("s", user, { provider: "openai", model: "m" }, tools, () => new Promise(() => {}), { callTimeoutMs: 30 });
    assert.equal(result.content, "ok");
    assert.match(calls[1].body.messages.at(-1).content, /^Tool timed out/);
  });

  test("an oversized result is capped; invalid arguments are refused", async (t) => {
    const calls = stubFetch(t, (_u, _i, n) => n === 0 ? openaiCall("c0", "not json") : n === 1 ? openaiCall("c1") : openaiText("ok"));
    await callLLMWithTools("s", user, { provider: "openai", model: "m" }, tools, async () => "é".repeat(50_000));
    assert.equal(calls[1].body.messages.at(-1).content, "Tool arguments were not a JSON object.");
    const capped = calls[2].body.messages.at(-1).content;
    assert.ok(Buffer.byteLength(capped) <= 8 * 1024);
    assert.ok(capped.endsWith("..."));
    assert.equal(capBytes("abc", 10), "abc");
  });

  test("callLLM with no tools sends no tool fields", async (t) => {
    const calls = stubFetch(t, () => anthropicText("plain"));
    assert.equal(await callLLM("sys", user, { provider: "anthropic", model: "claude-x" }), "plain");
    assert.equal(calls[0].body.tools, undefined);
    assert.equal(calls[0].body.tool_choice, undefined);
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "hi" }]);
  });

  test("only anthropic and the openai-compatible providers support tools", async () => {
    assert.deepEqual(["anthropic", "openai", "together", "openai_compatible", "replicate", "ollama"].map(supportsTools), [true, true, true, true, false, false]);
    await assert.rejects(callLLMWithTools("s", user, { provider: "replicate", model: "m" }, tools, async () => ""), /not available/);
  });
});

function home(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-seatconn-")));
  const old = process.env.ROUNDTABLE_HOME;
  process.env.ROUNDTABLE_HOME = dir;
  t.after(() => { if (old === undefined) delete process.env.ROUNDTABLE_HOME; else process.env.ROUNDTABLE_HOME = old; rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const connector = (extra = {}) => ({ command: process.execPath, args: [SERVER], env: {}, ...extra });

describe("seat connector session", () => {
  test("offers only read-only tools by default; the config's tools list opts others in", async (t) => {
    const dir = home(t);
    setConnectorConfig("desk", connector(), dir);
    setConnectorConfig("notes", connector({ tools: ["post_note"] }), dir);
    const session = await startSeatConnectors(["desk", "notes"]);
    t.after(() => session.close());
    const names = [...session.toolNames].sort();
    assert.ok(names.includes("desk__lookup") && !names.includes("desk__post_note"));
    assert.ok(names.includes("notes__post_note") && names.includes("notes__lookup"));
    const turn = session.turn("ada");
    const out = await turn.run("desk__post_note", {}, AbortSignal.timeout(5000));
    assert.equal(out.isError, true);
    assert.equal((await turn.run("nope__x", {}, AbortSignal.timeout(5000))).isError, true);
  });

  test("allowedTools validates names and namespaces them", () => {
    const listed = [
      { name: "ok_tool", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "bad name!", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "write", inputSchema: { type: "object" } },
      { name: "listed", inputSchema: { type: "object" } },
    ];
    assert.deepEqual(allowedTools("desk", { tools: ["listed"] }, listed).map(x => x.spec.name), ["desk__ok_tool", "desk__listed"]);
  });

  test("the server env is stripped; only broker values are added; results are fenced and scrubbed", async (t) => {
    const dir = home(t);
    process.env.SEAT_PARENT_PRIVATE = "parent-private-value";
    process.env.SEAT_TEST_LOGIN = "broker-secret-value-123";
    t.after(() => { delete process.env.SEAT_PARENT_PRIVATE; delete process.env.SEAT_TEST_LOGIN; });
    setConnectorConfig("desk", connector({ env: { SEAT_TOKEN: "secret://env/SEAT_TEST_LOGIN", REGION: "us" } }), dir);
    const session = await startSeatConnectors(["desk"]);
    t.after(() => session.close());
    const turn = session.turn("ada");
    const env = await turn.run("desk__env_names", {}, AbortSignal.timeout(5000));
    assert.ok(!env.text.includes("SEAT_PARENT_PRIVATE") && !env.text.includes("ANTHROPIC_API_KEY"));
    assert.ok(env.text.includes("SEAT_TOKEN") && env.text.includes("REGION"));
    const leak = await turn.run("desk__leak", {}, AbortSignal.timeout(5000));
    assert.ok(!leak.text.includes("broker-secret-value-123"), leak.text);
    const nonce = /<<<TOOL RESULT (\w+) desk__leak>>>/.exec(leak.text)?.[1];
    assert.ok(nonce && leak.text.endsWith(`<<<END TOOL RESULT ${nonce}>>>`));
    assert.ok(turn.instruction.includes(nonce) && turn.instruction.includes("untrusted data") && turn.instruction.includes("never instructions"));
    assert.notEqual(session.turn("ada").instruction, turn.instruction, "a fresh nonce per turn");
    const big = await turn.run("desk__big", {}, AbortSignal.timeout(5000));
    assert.ok(Buffer.byteLength(big.text) <= 8 * 1024 && big.text.includes("END TOOL RESULT"));
    const boom = await turn.run("desk__boom", {}, AbortSignal.timeout(5000));
    assert.equal(boom.isError, true);
  });

  test("notes name the seat and tool and carry no payload", async (t) => {
    const dir = home(t);
    setConnectorConfig("desk", connector(), dir);
    const notes = [];
    const session = await startSeatConnectors(["desk"], { onNote: u => notes.push(u.note) });
    t.after(() => session.close());
    await session.turn("ada").run("desk__lookup", { q: "top-secret-query-text" }, AbortSignal.timeout(5000));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^ada used desk__lookup \(ok, \d+ bytes; arguments: q\)$/);
    assert.ok(!notes[0].includes("top-secret-query-text") && !notes[0].includes("found:"));
  });

  test("an unknown connector is refused before anything starts", async (t) => {
    const dir = home(t);
    setConnectorConfig("desk", connector(), dir);
    assert.throws(() => assertConnectorsKnown(["desk", "missing"]), /Unknown connector: missing/);
    await assert.rejects(startSeatConnectors(["missing"]), /Unknown connector/);
    assert.deepEqual(assertConnectorsKnown(["desk", "desk"]), ["desk"]);
    assert.deepEqual(assertConnectorsKnown(undefined), []);
  });

  test("close ends the server; an abort closes it too", async (t) => {
    const dir = home(t);
    const pids = join(dir, "pids.log");
    setConnectorConfig("desk", connector({ env: { SEAT_FIXTURE_PID: pids } }), dir);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const gone = async (pid) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100)); return !alive(pid); };
    const a = await startSeatConnectors(["desk"]);
    const first = Number(readFileSync(pids, "utf8").trim().split("\n").at(-1));
    assert.ok(alive(first));
    await a.close();
    await a.close();
    assert.ok(await gone(first), "the server exits when the session closes");
    assert.equal(a.turn("ada"), undefined, "no tools once closed");
    const controller = new AbortController();
    const b = await startSeatConnectors(["desk"], { signal: controller.signal });
    const second = Number(readFileSync(pids, "utf8").trim().split("\n").at(-1));
    assert.ok(alive(second) && second !== first);
    controller.abort();
    assert.ok(await gone(second), "the server exits when the session aborts");
    assert.equal(b.turn("ada"), undefined);
  });
});

describe("callSeat with connectors", () => {
  test("an anthropic seat calls a connector tool; the instruction rides in the system prompt", async (t) => {
    const dir = home(t);
    setConnectorConfig("desk", connector(), dir);
    const session = await startSeatConnectors(["desk"]);
    t.after(() => session.close());
    const notes = [];
    session.onNote(u => notes.push(u.note));
    const calls = stubFetch(t, (_u, _i, n) => n === 0
      ? json(200, { model: "m", content: [{ type: "tool_use", id: "t1", name: "desk__lookup", input: { q: "x" } }], usage: { input_tokens: 1, output_tokens: 1 } })
      : anthropicText("final"));
    const text = await withSeatConnectors(session, () => callSeat("persona", user, { provider: "anthropic", model: "claude-x" }, { agent: "ada" }));
    assert.equal(text, "final");
    assert.match(calls[0].body.system, /^persona\n\nYou may call tools/);
    assert.ok(calls[1].body.messages.at(-1).content[0].content.includes("found: x"));
    assert.deepEqual(notes.map(n => n.replace(/\d+ bytes/, "N bytes")), ["ada used desk__lookup (ok, N bytes; arguments: q)"]);
  });

  test("a replicate seat reports unavailable once and still speaks", async (t) => {
    const dir = home(t);
    setConnectorConfig("desk", connector(), dir);
    const session = await startSeatConnectors(["desk"]);
    t.after(() => session.close());
    const notes = [];
    session.onNote(u => notes.push(u.note));
    stubFetch(t, (url, init) => {
      if ((init.method ?? "GET") === "GET") return json(200, { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {} } } } } } } });
      return json(200, { status: "succeeded", output: ["spoke"] });
    });
    const speak = () => withSeatConnectors(session, () => callSeat("persona", user, { provider: "replicate", model: "meta/llama" }, { agent: "bo" }));
    assert.equal(await speak(), "spoke");
    assert.equal(await speak(), "spoke");
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Connectors unavailable for seat bo/);
  });

  test("without a session callSeat is unchanged", async (t) => {
    const calls = stubFetch(t, () => anthropicText("plain"));
    assert.equal(await callSeat("persona", user, { provider: "anthropic", model: "claude-x" }, { agent: "ada" }), "plain");
    assert.equal(calls[0].body.tools, undefined);
    assert.equal(calls[0].body.system, "persona");
  });
});
