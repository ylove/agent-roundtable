import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDuel } from "../../dist/table/duel.js";
import { startDuelTool } from "../../dist/tools/duel.js";
import { parseTableArgs, runTableCli } from "../../dist/cli-table.js";
import { setConnectorConfig } from "../../dist/user-config.js";
import { startCollaboration, endCollaboration } from "../../dist/sessions/collaborations.js";
import { json, stubFetch } from "./helpers.mjs";

const SERVER = resolve(fileURLToPath(new URL("../fixtures/connectors/seat-server.mjs", import.meta.url)));
const SECRET = "broker-secret-value-123";
const seats = [
  ["designer", "A", "designer"], ["builder", "A", "builder"], ["marketer", "B", "designer"], ["skeptic", "B", "builder"], ["cfo", "judge", "judge"],
].map(([name, team, role]) => ({ id: name, name, team, role, provider: "openai_compatible", model: "m", prompt: `You are the ${name}.` }));
const page = team => `<prototype kind="web" title="T${team}" entry="index.html"><file path="index.html"><!doctype html><html lang="en"><title>T${team}</title><p>hi</p></html></file></prototype>`;
const options = { topic: "A brief", teamA: ["designer", "builder"], teamB: ["marketer", "skeptic"], judges: ["cfo"], pageCheck: false };

function env(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-seatmodes-")));
  const saved = { home: process.env.ROUNDTABLE_HOME, base: process.env.OPENAI_COMPATIBLE_BASE_URL, login: process.env.SEAT_MODES_LOGIN };
  process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.SEAT_MODES_LOGIN = SECRET;
  t.after(() => {
    for (const [k, v] of [["ROUNDTABLE_HOME", saved.home], ["OPENAI_COMPATIBLE_BASE_URL", saved.base], ["SEAT_MODES_LOGIN", saved.login]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const pids = join(dir, "pids.log");
  setConnectorConfig("desk", { command: process.execPath, args: [SERVER], env: { SEAT_TOKEN: "secret://env/SEAT_MODES_LOGIN", SEAT_FIXTURE_PID: pids } });
  return { dir, pids };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a duel seat uses a connector; the transcript, events and archive carry only the note", async t => {
  const { pids } = env(t);
  let toolCalls = 0;
  const calls = stubFetch(t, (_url, init) => {
    const req = JSON.parse(init.body);
    const last = req.messages.at(-1);
    const prompt = req.messages.find(m => m.role === "user")?.content ?? "";
    if (req.tools && prompt.startsWith("R1 CONCEPT") && /Team A/.test(prompt) && last.role === "user") {
      toolCalls++;
      return json(200, { model: "m", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "desk__leak", arguments: "{}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    }
    let content = "ok";
    if (prompt.startsWith("R1b BUILD")) content = page(/Team A/.test(prompt) ? "A" : "B");
    else if (prompt.startsWith("R2 JUDGE")) content = "VERDICT A: APPROVE — fine\nVERDICT B: REVISE — meh\nPREFER: A";
    return json(200, { model: "m", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  });
  const events = [];
  const result = await runDuel({ ...options, connectors: ["desk"] }, { onEvent(e) { events.push(e); } }, new AbortController().signal, { resolveSeats: () => seats });
  assert.equal(toolCalls, 1);
  const notes = events.filter(e => e.type === "turn" && e.round === "tool");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^designer used desk__leak \(ok, \d+ bytes\)$/);
  assert.equal(notes[0].seat.id, "designer");
  // The model got the (scrubbed, fenced) result; nothing else did.
  const toolMessage = calls.flatMap(c => c.body.messages).find(m => m.role === "tool");
  assert.match(toolMessage.content, /^<<<TOOL RESULT \w+ desk__leak>>>\ntoken is /);
  assert.ok(!toolMessage.content.includes(SECRET));
  for (const text of [JSON.stringify(events), readFileSync(result.archivePath, "utf8")]) assert.ok(!text.includes("token is") && !text.includes(SECRET));
  const pid = Number(readFileSync(pids, "utf8").trim());
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(!alive(pid), "the connector server is closed when the duel ends");
});

test("an unknown connector is refused before any provider call", async t => {
  env(t);
  const calls = stubFetch(t, () => json(500, {}));
  await assert.rejects(runDuel({ ...options, connectors: ["missing"] }, { onEvent() {} }, new AbortController().signal, { resolveSeats: () => seats }), /Unknown connector: missing/);
  await assert.rejects(startDuelTool({ topic: "t", team_a: ["designer"], team_b: ["marketer"], judges: ["cfo"], connectors: ["missing"] }), /Unknown connector: missing/);
  await assert.rejects(startCollaboration(["designer", "builder"], "t", { connectors: ["missing"] }), /Unknown connector: missing/);
  assert.equal(calls.length, 0);
});

test("the table CLI parses --connectors and refuses an unknown one with a usage error", async t => {
  env(t);
  const parsed = parseTableArgs("debate", ["topic", "--agents", "a,b", "--connectors", "desk,other"]);
  assert.deepEqual(parsed.options.connectors, ["desk", "other"]);
  assert.throws(() => parseTableArgs("duel", ["--dry-run", "--connectors", "desk"]), /not available with replay/);
  assert.throws(() => parseTableArgs("debate", ["topic", "--agents", "a,b", "--connectors", "desk,"]), /comma-separated/);
  const out = [], err = [];
  const calls = stubFetch(t, () => json(500, {}));
  const code = await runTableCli("debate", ["topic", "--agents", "designer,builder", "--connectors", "missing", "--no-preflight"], { output: { write: s => out.push(s) }, error: { write: s => err.push(s) } });
  assert.equal(code, 2);
  assert.match(err.join(""), /Unknown connector: missing/);
  assert.equal(calls.length, 0);
});

test("a collaboration gives its seats the connector and ends the server with the session", async t => {
  const { pids } = env(t);
  const agents = process.env.ROUNDTABLE_AGENTS_DIR;
  mkdirSync(agents, { recursive: true });
  for (const id of ["ada", "bo"]) writeFileSync(join(agents, `${id}.md`), `You are ${id}.\n`);
  process.env.OPENAI_API_KEY = "sk-test";
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const sent = [];
  stubFetch(t, (_url, init) => {
    const req = JSON.parse(init.body);
    sent.push(req);
    if (req.tools && req.messages.at(-1).role === "user" && sent.filter(r => r.tools).length === 1) {
      return json(200, { model: "m", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "desk__lookup", arguments: '{"q":"x"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    }
    return json(200, { model: "m", choices: [{ finish_reason: "stop", message: { content: "my view" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
  });
  const seen = [];
  const started = await startCollaboration(["ada", "bo"], "topic", { provider: "openai", model: "m", connectors: ["desk"], maxRounds: 1, onToolNote: u => seen.push(u.note) });
  assert.match(seen[0], /^ada used desk__lookup/);
  assert.ok(sent[0].tools.some(t => t.function.name === "desk__lookup"));
  assert.ok(!sent[0].tools.some(t => /post_note/.test(t.function.name)));
  const pid = Number(readFileSync(pids, "utf8").trim());
  assert.ok(alive(pid));
  const ended = await endCollaboration(started.collaborationId, false);
  assert.deepEqual(ended.toolUses, seen);
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(!alive(pid), "the connector server is closed when the session ends");
});
