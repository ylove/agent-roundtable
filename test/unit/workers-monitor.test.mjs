// RunMonitor over fixture output files (claude-code and codex), and the codex driver's argv and parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { RunMonitor } = await import("../../dist/workers/monitor.js");
const { parseClaudeLine } = await import("../../dist/workers/claude-code.js");
const codex = await import("../../dist/workers/codex.js");
const { validateDraft } = await import("../../dist/execution/events.js");

const SID = "11111111-2222-4333-8444-555555555555";
const init = (tools = ["Read", "Edit", "Write", "Glob", "Grep", "mcp__roundtable__lease"], servers = [{ name: "roundtable", status: "connected" }]) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: SID, tools, mcp_servers: servers, model: "claude-sonnet-5" });
const assistant = (id, text, usage = { input_tokens: 10, output_tokens: 20 }) =>
  JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5", content: [{ type: "text", text }], usage } });
const result = (over = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: SID, total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }, modelUsage: { "claude-sonnet-5": { costUSD: 0.25 } }, ...over });

const file = () => join(mkdtempSync(join(tmpdir(), "rt-monitor-")), "1.jsonl");
const monitor = (path, over = {}) => new RunMonitor({ path, parse: parseClaudeLine, agent: "builder-1", task: "api", provider: "claude-code", ...over });

test("poll: attestation once at init, usage at the result, partial lines wait for their newline", () => {
  const path = file();
  const m = monitor(path);
  assert.deepEqual(m.poll(), { drafts: [], done: false, bytes: 0 }, "a missing file is no output yet");
  writeFileSync(path, "stderr noise\n" + init() + "\n" + assistant("m1", "working").slice(0, 30));
  const p1 = m.poll();
  assert.equal(p1.drafts.length, 1);
  assert.equal(p1.drafts[0].type, "agent.attested");
  assert.deepEqual(p1.drafts[0].payload, { agent: "builder-1", tools: ["Read", "Edit", "Write", "Glob", "Grep", "mcp__roundtable__lease"], mcp_servers: ["roundtable"], ok: true });
  assert.equal(p1.attestation.ok, true);
  assert.equal(m.acc.lastText, undefined, "the half line is not parsed yet");
  appendFileSync(path, assistant("m1", "working").slice(30) + "\n");
  assert.deepEqual(m.poll().drafts, []);
  assert.equal(m.acc.lastText, "working");
  appendFileSync(path, result() + "\n");
  const p3 = m.poll();
  assert.equal(p3.done, true);
  assert.deepEqual(p3.drafts.map((d) => d.type), ["budget.usage_recorded"]);
  assert.deepEqual(p3.drafts[0].payload, {
    source: "worker", agent: "builder-1", task: "api", model: "claude-sonnet-5", provider: "claude-code",
    tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 }, usd: 0.25, estimated: false,
  });
  for (const d of [...p1.drafts, ...p3.drafts]) validateDraft(d);
  const exit = m.finish({ code: 0, signal: null });
  assert.deepEqual(exit.map((d) => d.type), ["agent.exited"]);
  assert.deepEqual(exit[0].payload, { agent: "builder-1", task: "api", code: 0, reason: "completed", result_subtype: "success", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 } });
  validateDraft(exit[0]);
  assert.deepEqual(m.finish({ code: 0 }), [], "finish is idempotent");
  assert.equal(exit[0].source.kind, "runner");
});

test("an attestation mismatch is reported and becomes the exit reason", () => {
  const path = file();
  writeFileSync(path, init(["Read", "Bash", "mcp__evil__x"], [{ name: "roundtable", status: "connected" }, { name: "evil", status: "connected" }]) + "\n");
  const m = monitor(path);
  const p = m.poll();
  assert.equal(p.attestation.ok, false);
  assert.deepEqual(p.attestation.unexpected, ["Bash", "mcp__evil__x", "mcp server evil"]);
  assert.equal(p.drafts[0].payload.ok, false);
  const exit = m.finish({ code: null, signal: "SIGKILL" });
  assert.equal(exit.at(-1).payload.reason, "attestation");
});

test("exit reasons: budget, killed, error; a run killed before its result records the usage it had seen", () => {
  const budget = file();
  writeFileSync(budget, init() + "\n" + result({ subtype: "error_max_budget_usd", is_error: true }) + "\n");
  const mb = monitor(budget);
  mb.poll();
  assert.equal(mb.finish({ code: 1 }).at(-1).payload.reason, "budget");

  const killed = file();
  writeFileSync(killed, init() + "\n" + assistant("m1", "a", { input_tokens: 5, output_tokens: 7 }) + "\n" + assistant("m2", "b", { input_tokens: 1, output_tokens: 2 }) + "\n");
  const mk = monitor(killed);
  const drafts = mk.finish({ code: null, signal: "SIGTERM" });
  assert.deepEqual(drafts.map((d) => d.type), ["agent.attested", "budget.usage_recorded", "agent.exited"]);
  const usage = drafts[1].payload;
  assert.equal(usage.estimated, true, "no cost was reported");
  assert.deepEqual(usage.tokens, { inputTokens: 6, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(usage.usd > 0, "priced from the pricing table");
  assert.equal(drafts[2].payload.reason, "killed");

  const errored = file();
  writeFileSync(errored, init() + "\n" + result({ subtype: "error_during_execution", is_error: true }));
  const me = monitor(errored);
  const d = me.finish({ code: 1 });
  assert.ok(d.some((x) => x.type === "budget.usage_recorded"), "a final line without its newline is still read");
  assert.equal(d.at(-1).payload.reason, "error");
  assert.equal(monitor(file()).finish({ code: 0, reason: "stalled" }).at(-1).payload.reason, "stalled");
});

test("an adopted run resumes from its offset; an overlong line is skipped without losing the offset", () => {
  const path = file();
  writeFileSync(path, init() + "\n");
  const first = monitor(path);
  first.poll();
  const huge = JSON.stringify({ type: "user", blob: "x".repeat(9 << 20) });
  appendFileSync(path, huge + "\n" + assistant("m9", "after the big line") + "\n");
  const adopted = monitor(path, { offset: first.offset });
  const p = adopted.poll();
  assert.deepEqual(p.drafts, [], "no second attestation: init was before the offset");
  assert.equal(adopted.acc.lastText, "after the big line");
  assert.equal(adopted.offset, Buffer.byteLength(init() + "\n" + huge + "\n" + assistant("m9", "after the big line") + "\n"));
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

const MCP = { command: "/opt/node/bin/node", args: ["/opt/rt/dist/index.js", "mcp", "--worker", "--execution", "exe-0000000000abcdef", "--agent", "builder-1", "--token-file", "/s/token"], env: { ROUNDTABLE_DOTENV: "off", ROUNDTABLE_HOME: "/s" } };

test("buildCodexArgs and buildCodexResumeArgs (snapshots)", () => {
  const cfg = [
    "-c", "shell_environment_policy.inherit=core",
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", 'approval_policy="never"',
    "-c", 'mcp_servers.roundtable.command="/opt/node/bin/node"',
    "-c", 'mcp_servers.roundtable.args=["/opt/rt/dist/index.js","mcp","--worker","--execution","exe-0000000000abcdef","--agent","builder-1","--token-file","/s/token"]',
    "-c", 'mcp_servers.roundtable.env={ROUNDTABLE_DOTENV="off",ROUNDTABLE_HOME="/s"}',
  ];
  assert.deepEqual(codex.buildCodexArgs({ cwd: "/wt" }, MCP), ["exec", "--json", "-C", "/wt", "-s", "workspace-write", "--ignore-user-config", ...cfg, "-"]);
  assert.deepEqual(codex.buildCodexArgs({ cwd: "/wt", model: "gpt-5.6" }, MCP).slice(-3), ["-m", "gpt-5.6", "-"]);
  assert.deepEqual(codex.buildCodexResumeArgs("01a13f90-4d81-7413-a355-d0d09239222c", {}, MCP), [
    "exec", "resume", "--json", "--ignore-user-config", "-c", 'sandbox_mode="workspace-write"', ...cfg, "01a13f90-4d81-7413-a355-d0d09239222c", "-",
  ]);
  assert.throws(() => codex.buildCodexResumeArgs("--last", {}, MCP), /invalid thread/);
  assert.throws(() => codex.buildCodexArgs({ cwd: "/wt", model: "-x" }, MCP), /invalid model/);
  assert.throws(() => codex.buildCodexArgs({ cwd: "/wt" }, { ...MCP, env: { "A=B": "x" } }), /invalid env/);
});

test("parseCodexLine and RunMonitor: thread id, last message, summed turn usage (estimated), failures", () => {
  const path = file();
  writeFileSync(path, [
    JSON.stringify({ type: "thread.started", thread_id: "01a13f90-4d81-7413-a355-d0d09239222c" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "mcp_tool_call", server: "roundtable", tool: "lease" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 14287, cached_input_tokens: 12288, output_tokens: 5, reasoning_output_tokens: 3 } }),
  ].join("\n") + "\n");
  const m = new RunMonitor({ path, parse: codex.parseCodexLine, agent: "builder-1", task: "api", provider: "codex", expected: null, model: "gpt-5.6" });
  const p = m.poll();
  assert.equal(m.acc.sessionId, "01a13f90-4d81-7413-a355-d0d09239222c");
  assert.equal(m.acc.lastText, "OK");
  assert.deepEqual(m.acc.mcpServers, ["roundtable"]);
  assert.deepEqual(p.drafts.map((d) => d.type), ["budget.usage_recorded"], "no attestation for codex");
  assert.deepEqual(p.drafts[0].payload.tokens, { inputTokens: 14287, outputTokens: 8, cacheReadTokens: 12288 });
  assert.equal(p.drafts[0].payload.estimated, true);
  assert.equal(p.drafts[0].payload.model, "gpt-5.6");

  const acc = { done: false, lines: 0 };
  codex.parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }), acc);
  assert.deepEqual({ done: acc.done, isError: acc.isError, resultSubtype: acc.resultSubtype, lastText: acc.lastText }, { done: true, isError: true, resultSubtype: "error", lastText: "rate limited" });
});

test("a monitor checkpoint preserves attestation, per-message usage and a consumed result across adoption", () => {
  const path = file();
  writeFileSync(path, init() + "\n" + assistant("before", "working", { input_tokens: 7, output_tokens: 11 }) + "\n");
  const first = monitor(path);
  first.poll();
  const adopted = monitor(path, { offset: first.offset, checkpoint: first.checkpoint() });
  assert.equal(adopted.attestation.ok, true);
  const drafts = adopted.finish({ code: null, signal: "SIGTERM" });
  assert.equal(drafts.some((d) => d.type === "agent.attested"), false);
  assert.equal(drafts.find((d) => d.type === "budget.usage_recorded").payload.tokens.inputTokens, 7);
  assert.equal(drafts.at(-1).payload.reason, "killed");

  appendFileSync(path, result() + "\n");
  const finished = monitor(path);
  finished.poll();
  const again = monitor(path, { offset: finished.offset, checkpoint: finished.checkpoint() });
  assert.equal(again.acc.done, true);
  assert.deepEqual(again.finish({ code: 0 }).map((d) => d.type), ["agent.exited"]);
});

test("a worker that exits without init fails attestation, including an unterminated init line", () => {
  const empty = monitor(file());
  const drafts = empty.finish({ code: 0 });
  assert.equal(drafts.find((d) => d.type === "agent.attested").payload.ok, false);
  assert.equal(drafts.at(-1).payload.reason, "attestation");
  const path = file();
  writeFileSync(path, init(["Bash"]));
  const bad = monitor(path).finish({ code: 1 });
  assert.equal(bad.find((d) => d.type === "agent.attested").payload.ok, false);
});
