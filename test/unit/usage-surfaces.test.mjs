// The status line, the usage CLI and the usage tool (usage-visibility.md §3, §5, §8): the owner's exact
// line 1, tolerance of missing fields and bad JSON, colour and width rules, the 2 s cache, no-home
// behaviour, exit 0 on failure, and the friendly report and its JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, frozenRun } from "../fixtures/execution/run.mjs";

const { parseHost, hostLine, painter, renderStatusline, statuslineText, visibleWidth, clock, readHostFigures } = await import("../../dist/usage/statusline.js");
const F = await import("../../dist/usage/format.js");
const { renderReport } = await import("../../dist/usage/report.js");
const { collectUsage } = await import("../../dist/usage/model.js");
const { handleToolCall } = await import("../../dist/tools.js");
const T = await import("../../dist/usage/table.js");

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const HOME = process.env.ROUNDTABLE_HOME;
const ANSI = /\u001b\[[0-9;]*m/g;

/** The host's status line JSON as a Claude Code session sends it. 1893448200 is 2029-12-31T21:50:00Z. */
const HOST = {
  session_id: "s-1",
  cwd: "/work/agent-mcp/src",
  model: { id: "model-a", display_name: "Opus 5.5" },
  workspace: { current_dir: "/work/agent-mcp/src", project_dir: "/work/agent-mcp" },
  cost: { total_cost_usd: 3.5 },
  rate_limits: { five_hour: { used_percentage: 0, resets_at: 1893448200 }, seven_day: { used_percentage: 82, resets_at: 1893900000 } },
};

function run(args, { input = "", env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8", env: { ...process.env, TZ: "UTC", ROUNDTABLE_HOME: HOME, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const agent = (over) => ({
  id: "builder", where: "heads-down", scope: "exe-0123456789abcdef", provider: "claude-code", models: ["model-a"],
  tokens: { input: 1000, output: 200, cache_read: 0, cache_write: 0, by: { measured: 1200, reported: 0, estimated: 0 } },
  money: { measured: 0.92, reported: 0, estimated: 0 }, state: "working", stoppable: true, ...over,
});
const view = (over = {}) => ({
  generated_at: new Date().toISOString(),
  totals: { measured: 1.62, reported: 0, estimated: 0.22, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, by: { measured: 0, reported: 0, estimated: 0 } } },
  platforms: [], agents: [agent()], stops: [],
  runs: [{ id: "exe-0123456789abcdef", status: "running", tasks: { done: 4, total: 7 }, money: { measured: 1.62, reported: 0, estimated: 0.22 },
    tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0, by: { measured: 2, reported: 0, estimated: 0 } }, budget_usd: 20, budget_pct: 9.2, agents: 1, live: true }],
  table: { sessions: 2, agents: 2, money: { measured: 0, reported: 0, estimated: 0.05 }, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, by: { measured: 0, reported: 0, estimated: 0 } } },
  ...over,
});
const plain = { host: true, agents: 4, color: false, cols: 120 };

// --- line 1 -----------------------------------------------------------------------------------------

test("statusline line 1 reproduces the owner's format exactly from the host's JSON", () => {
  assert.equal(hostLine(parseHost(JSON.stringify(HOST))), "Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%");
  const r = run(["statusline", "--plain"], { input: JSON.stringify(HOST), env: { ROUNDTABLE_HOME: join(tmpdir(), "no-such-roundtable-home") } });
  assert.equal(r.code, 0);
  assert.equal(r.out, "Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%\n");
  assert.equal(r.err, "");
});

test("statusline line 1: project is the project directory's basename (else the current directory's); reset times may be seconds, milliseconds or ISO", () => {
  const h = (over) => hostLine(parseHost(JSON.stringify({ ...HOST, ...over })));
  assert.match(h({ workspace: { current_dir: "/work/other/" } }), /^Opus 5\.5 \| other \|/);
  assert.match(h({ workspace: undefined, cwd: "C:\\work\\win-proj" }), /\| win-proj \|/);
  for (const resets_at of [1893448200, 1893448200000, "2029-12-31T21:50:00Z"]) {
    assert.match(h({ rate_limits: { five_hour: { used_percentage: 12.4, resets_at } } }), /5h 12%→21:50$/, String(resets_at));
  }
  assert.equal(clock(Date.UTC(2029, 0, 1, 7, 5)), "07:05", "zero padded, local time");
});

test("statusline tolerates missing fields: a missing field is left out with its separator", () => {
  const h = (o) => hostLine(parseHost(JSON.stringify(o)));
  assert.equal(h({}), "");
  assert.equal(h({ model: { display_name: "Opus 5.5" } }), "Opus 5.5");
  assert.equal(h({ model: { id: "model-a" } }), "model-a", "the id when there is no display name");
  assert.equal(h({ workspace: { project_dir: "/a/b" }, rate_limits: { seven_day: { used_percentage: 40 } } }), "b | 7d 40%");
  assert.equal(h({ model: { display_name: "X" }, rate_limits: { five_hour: { used_percentage: 3 } } }), "X | 5h 3%", "no reset time, no arrow");
  assert.equal(h({ model: 5, workspace: "x", rate_limits: { five_hour: { used_percentage: "lots" }, seven_day: null } }), "");
  assert.equal(h({ model: { display_name: "k ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" } }).includes("ghp_"), false, "names are scrubbed");
});

test("the host's reported cost is clamped to the spec's $10,000, wherever it is read", async () => {
  assert.equal(parseHost(JSON.stringify({ cost: { total_cost_usd: 1e300 } })).cost_usd, 10_000);
  assert.equal(parseHost(JSON.stringify({ cost: { total_cost_usd: 3.5 } })).cost_usd, 3.5);
  assert.equal(parseHost(JSON.stringify({ cost: { total_cost_usd: -1 } })).cost_usd, undefined);
  const dir = mkdtempSync(join(tmpdir(), "statusline-home-"));
  mkdirSync(join(dir, "usage"), { recursive: true });
  writeFileSync(join(dir, "usage", "host.json"), JSON.stringify({ model: "Opus 5.5", cost_usd: 1e300, at: new Date().toISOString() }));
  assert.equal(readHostFigures(dir).cost_usd, 10_000);
  const v = await collectUsage({ executions: [], home: dir, host: { model: "m", cost_usd: 1e300 } });
  assert.equal(v.agents.find((a) => a.where === "host").money.reported, 10_000);
});

test("statusline line 2 summarises the live run that has spent the most", () => {
  const run = (id, measured) => ({ ...view().runs[0], id, money: { measured, reported: 0, estimated: 0 } });
  const v = view({ runs: [run("exe-aaaaaaaaaaaa1111", 0.1), run("exe-bbbbbbbbbbbb2222", 5), run("exe-cccccccccccc3333", 1)] });
  const [l2] = renderStatusline(v, {}, plain);
  assert.match(l2, /heads-down exe-bb2222 .*\$5\.00 meas.*\(\+2 more\)/);
});

test("statusline never fails: invalid JSON, empty stdin, junk flags and a missing home all exit 0 without a stack trace", () => {
  const nohome = { ROUNDTABLE_HOME: join(tmpdir(), "no-such-roundtable-home") };
  for (const input of ["", "not json", "[1,2,3]", "null", '{"model":', "\u0000\u0001", "x".repeat(10_000)]) {
    const r = run(["statusline", "--plain"], { input, env: nohome });
    assert.equal(r.code, 0, input.slice(0, 20));
    assert.equal(r.out, "", `nothing to show for ${JSON.stringify(input.slice(0, 20))}`);
    assert.equal(r.err, "");
  }
  const odd = run(["statusline", "--bogus", "--agents", "x", "--agents"], { input: JSON.stringify(HOST), env: nohome });
  assert.equal(odd.code, 0);
  assert.match(odd.out, /^Opus 5\.5 \| agent-mcp/);
  assert.equal(existsSync(nohome.ROUNDTABLE_HOME), false, "no roundtable home: nothing is created for the status line");
});

test("statusline answers as soon as the host's JSON is complete, even if the host keeps stdin open", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [BIN, "statusline", "--plain"], { env: { ...process.env, TZ: "UTC", ROUNDTABLE_HOME: join(tmpdir(), "no-such-roundtable-home") }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const started = Date.now();
  child.stdin.write(JSON.stringify(HOST));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(out, "Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%\n");
  assert.ok(Date.now() - started < 3000, "no waiting for stdin to close");
});

test("statusline --no-host omits line 1", async () => {
  const lines = renderStatusline(view(), parseHost(JSON.stringify(HOST)), { ...plain, host: false });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("◆ roundtable"));
});

// --- lines 2 and 3 -----------------------------------------------------------------------------------

test("statusline line 2 and 3: the roundtable at a glance and the busiest agents, every figure with its provenance label", () => {
  const v = view({
    agents: [
      agent({ id: "builder", stoppable: false, money: { measured: 0.92, reported: 0, estimated: 0 } }),
      agent({ id: "fixer", money: { measured: 0.4, reported: 0, estimated: 0 }, stoppable: false }),
      agent({ id: "cfo", where: "at-the-table", scope: "meeting-aaaaaaaa", provider: "provider-a", stoppable: false,
        tokens: { input: 4000, output: 100, cache_read: 0, cache_write: 0, by: { measured: 4100, reported: 0, estimated: 0 } }, money: { measured: 0, reported: 0, estimated: 0.03 } }),
    ],
  });
  const lines = renderStatusline(v, {}, plain);
  assert.equal(lines[0], "◆ roundtable  heads-down exe-abcdef 4/7 tasks · $1.62 meas + ≈$0.22 est of $20 · table 2 agents ≈$0.05 est");
  assert.equal(lines[1], "  builder $0.92 meas [claude-code] · fixer $0.40 meas [claude-code] · cfo 4.1k tok meas ≈$0.03 est [provider-a]");
  // Reported money has its word too.
  const rep = renderStatusline(view({ agents: [agent({ money: { measured: 0, reported: 0.4, estimated: 0 } })] }), {}, plain);
  assert.match(rep[1], /builder \$0\.40 rep \[claude-code\]/);
});

test("statusline line 3: the stop hint names the exact command for one stoppable agent, else the generic form; nothing to show means only line 1", () => {
  const one = renderStatusline(view(), {}, plain);
  assert.match(one[1], /· stop: agent-roundtable stop builder$/);
  const two = renderStatusline(view({ agents: [agent(), agent({ id: "fixer" })] }), {}, plain);
  assert.match(two[1], /stop: agent-roundtable stop <agent>$/);
  const none = renderStatusline(view({ agents: [agent({ stoppable: false })] }), {}, plain);
  assert.doesNotMatch(none[1], /stop:/);
  const empty = renderStatusline(view({ runs: [], agents: [], table: { ...view().table, agents: 0, sessions: 0 } }), parseHost(JSON.stringify(HOST)), plain);
  assert.deepEqual(empty, ["Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%"]);
  // A finished run is not at a glance.
  const done = renderStatusline(view({ runs: [{ ...view().runs[0], live: false }], table: { ...view().table, agents: 0 } }), {}, plain);
  assert.deepEqual(done, []);
});

test("statusline width fitting drops agents before labels and never drops a provenance label", () => {
  const agents = ["alpha", "bravo", "charlie", "delta"].map((id, i) => agent({ id, money: { measured: 0.9 - i * 0.1, reported: 0, estimated: 0 } }));
  const v = view({ agents });
  const wide = renderStatusline(v, {}, { ...plain, cols: 400 })[1];
  assert.ok(wide.includes("alpha") && wide.includes("delta") && wide.includes("stop:"));
  let last = Infinity;
  for (const cols of [160, 120, 100, 80, 60, 40]) {
    const line = renderStatusline(v, {}, { ...plain, cols })[1];
    const shown = ["alpha", "bravo", "charlie", "delta"].filter((n) => line.includes(n));
    assert.ok(shown.length >= 1, `cols ${cols}: the busiest agent stays`);
    assert.deepEqual(shown, ["alpha", "bravo", "charlie", "delta"].slice(0, shown.length), "lowest spend goes first");
    assert.ok(shown.length <= last, "narrower never shows more");
    last = shown.length;
    // Every agent shown keeps its label.
    assert.equal((line.match(/\bmeas\b/g) ?? []).length, shown.length, `cols ${cols}: ${line}`);
    if (shown.length > 1 || cols >= 80) assert.ok(visibleWidth(line) <= cols, `cols ${cols}: ${visibleWidth(line)}`);
  }
  // Line 2 gives up its table segment before it overflows.
  const narrow2 = renderStatusline(v, {}, { ...plain, cols: 90 })[0];
  assert.ok(!narrow2.includes("table 2 agents") && narrow2.includes("meas"));
});

test("statusline colour: ANSI by default, none with --plain or NO_COLOR, and the text is the same either way", () => {
  const coloured = renderStatusline(view({ agents: [agent({ state: "stopped" }), agent({ id: "fixer" })] }), parseHost(JSON.stringify(HOST)), { ...plain, color: true });
  assert.ok(coloured.some((l) => ANSI.test(l)));
  ANSI.lastIndex = 0;
  const bare = renderStatusline(view({ agents: [agent({ state: "stopped" }), agent({ id: "fixer" })] }), parseHost(JSON.stringify(HOST)), plain);
  assert.deepEqual(coloured.map((l) => l.replace(ANSI, "")), bare, "colour never adds or removes words");
  assert.match(bare[2], /builder \(stopped\)/, "stopped is a word as well as amber");
  assert.equal(visibleWidth(painter(true)("31", "abc")), 3);
  const withColour = run(["statusline"], { input: JSON.stringify(HOST), env: { NO_COLOR: "" } });
  assert.match(withColour.out, /\u001b\[33m82%/, "82% of the 7-day window is amber");
  const noColour = run(["statusline"], { input: JSON.stringify(HOST), env: { NO_COLOR: "1" } });
  assert.equal(noColour.out, "Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%\n");
  assert.doesNotMatch(noColour.out, /\u001b/);
});

test("statusline over 80% of the budget turns red and says so in words", () => {
  const hot = view({ runs: [{ ...view().runs[0], budget_pct: 91.4 }] });
  const [l2] = renderStatusline(hot, {}, { ...plain, color: true });
  assert.match(l2, /\u001b\[31mof \$20 \(91%\)/);
  assert.match(renderStatusline(hot, {}, plain)[0], /of \$20 \(91%\)/);
});

// --- cache, speed, data ------------------------------------------------------------------------------

test("statusline serves a 2 s cache, then re-reads; it never reads message text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-home-"));
  const now = Date.now();
  const at = new Date(now).toISOString();
  const line = (agentName, extra = {}) => ({ at, server: "srv-aaaaaaaa", session: "meeting-aaaaaaaa", kind: "meeting", agent: agentName, provider: "provider-a", model: "m1",
    tokens: { input: 4000, output: 100, cache_read: 0, cache_write: 0 }, tokens_prov: "measured", usd: 0.03, usd_prov: "estimated", ...extra });
  T.appendTableLine(line("cfo"), dir);
  const first = await statuslineText("{}", { ...plain, home: dir, now });
  assert.match(first, /table 1 agent .*≈\$0\.03 est/);
  assert.ok(existsSync(join(dir, "usage", "statusline.cache.json")));
  T.appendTableLine(line("analyst"), dir);
  assert.equal(await statuslineText("{}", { ...plain, home: dir, now: now + 1500 }), first, "inside 2 s: the cached view");
  assert.match(await statuslineText("{}", { ...plain, home: dir, now: now + 2500 }), /table 2 agents/, "after 2 s: fresh");
  // A ledger line that carries text anyway (a foreign writer) never reaches the output.
  T.appendTableLine(line("sneaky", { content: "the secret prompt", prompt: "do the thing" }), dir);
  const view_ = await collectUsage({ executions: [], home: dir });
  assert.doesNotMatch(JSON.stringify(view_), /secret prompt|do the thing/);
});

test("statusline saves the host's figures for `usage`, labelled reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-home-"));
  const now = Date.now();
  await statuslineText(JSON.stringify(HOST), { ...plain, home: dir, now });
  assert.deepEqual(readHostFigures(dir, now), { model: "Opus 5.5", cost_usd: 3.5, at: new Date(now).toISOString() });
  assert.equal(readHostFigures(dir, now + 31 * 60_000), undefined, "stale after 30 minutes");
  const v = await collectUsage({ executions: [], home: dir, host: readHostFigures(dir, now) });
  const host = v.agents.find((a) => a.where === "host");
  assert.deepEqual(host.money, { measured: 0, reported: 3.5, estimated: 0 });
  assert.equal(v.totals.reported, 0, "the host's own cost is not part of the roundtable's total");
});

// --- wording ------------------------------------------------------------------------------------------

test("wording: measured plain, reported with rep, estimated with ≈; mixed totals show the split; no price instead of $0.00", () => {
  const t = (measured, reported, estimated) => ({ measured, reported, estimated });
  assert.equal(F.moneyText(t(0.92, 0, 0), "abbr"), "$0.92 meas");
  assert.equal(F.moneyText(t(0, 0.4, 0), "abbr"), "$0.40 rep");
  assert.equal(F.moneyText(t(0, 0, 0.12), "abbr"), "≈$0.12 est");
  assert.equal(F.moneyText(t(1.62, 0, 0.22), "words"), "$1.62 measured + ≈$0.22 estimated");
  assert.equal(F.totalText(t(1.62, 0, 0.22)), "$1.84 = $1.62 measured + ≈$0.22 estimated");
  assert.equal(F.totalText(t(0.5, 0, 0)), "$0.50 measured");
  assert.equal(F.totalText(t(0, 0, 0)), "$0.00");
  const tok = (n) => ({ input: n, output: 0, cache_read: 0, cache_write: 0, by: { measured: n, reported: 0, estimated: 0 } });
  assert.equal(F.useText(t(0, 0, 0), tok(4100), "abbr"), "4.1k tok meas no price");
  assert.equal(F.useText(t(0, 0, 0.03), tok(4100), "abbr"), "4.1k tok meas ≈$0.03 est");
  assert.equal(F.useText(t(0.92, 0, 0), tok(4100), "abbr"), "$0.92 meas", "measured money needs no token count beside it");
  assert.equal(F.useText(t(0, 0, 0), tok(0), "abbr"), "no usage yet");
  assert.equal(F.usd(0.004), "<$0.01");
  assert.equal(F.tokensShort(842), "842");
  assert.equal(F.tokensShort(12_400), "12k");
  assert.equal(F.tokensShort(1_250_000), "1.3M");
  assert.equal(F.usdBudget(20), "$20");
});

// --- the usage CLI and tool ---------------------------------------------------------------------------

let seeded;
const seed = () => (seeded ??= seedOnce());

async function seedOnce() {
  const { store } = await frozenRun();
  await emit(store, "agent.registered", { agent: "builder", persona: "dev", driver: "claude-code", token_sha256: "t", external: false });
  await emit(store, "agent.spawned", { agent: "builder", task: "a", attempt: 1, pid: process.pid });
  await emit(store, "budget.usage_recorded", { source: "worker", agent: "builder", task: "a", provider: "claude-code", model: "model-a", tokens: { inputTokens: 1000, outputTokens: 200 }, usd: 0.92, estimated: false, provenance: { tokens: "measured", usd: "measured" } });
  await emit(store, "agent.registered", { agent: "mail@example.com", persona: "dev", driver: "external", token_sha256: "t2", external: true });
  await emit(store, "budget.usage_recorded", { source: "worker", agent: "mail@example.com", provider: "external", model: "m", tokens: { inputTokens: 5, outputTokens: 5 }, usd: 0.1, estimated: false, provenance: { tokens: "reported", usd: "reported" } });
  return store;
}

test("usage prints a friendly report, its JSON, and an empty state that welcomes", async () => {
  const empty = run(["usage"], { env: { ROUNDTABLE_HOME: join(tmpdir(), "no-such-roundtable-home") } });
  assert.equal(empty.code, 0);
  assert.match(empty.out, /No usage yet\. Agents will show up here as soon as they start\./);
  const store = await seed();
  const text = run(["usage"]);
  assert.equal(text.code, 0);
  assert.doesNotMatch(text.out, /\u001b/, "no colour when not a terminal");
  assert.match(text.out, /So far {2}\$1\.02 = \$0\.92 measured \+ \$0\.10 reported/);
  for (const word of ["measured", "reported", "estimated", "Who is working", "By platform", "Heads-down runs", "builder", "claude-code"]) assert.ok(text.out.includes(word), word);
  assert.match(text.out, /Stop an agent with: agent-roundtable stop/);
  const json = JSON.parse(run(["usage", "--json"]).out);
  assert.equal(json.runs[0].id, store.id);
  assert.equal(json.agents.find((a) => a.id === "builder").money.measured, 0.92);
  assert.equal(json.totals.reported, 0.1);
  assert.equal(run(["usage", "--bogus"]).code, 2);
});

test("the usage tool reports the same view, redacted, and narrows by agent or run", async () => {
  const store = await seed();
  const r = await handleToolCall("usage", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  const v = JSON.parse(r.content[0].text);
  assert.ok(v.agents.some((a) => a.id === "builder"));
  assert.ok(!r.content[0].text.includes("mail@example.com"), "personal data is redacted");
  const one = JSON.parse((await handleToolCall("usage", { action: "report", agent: "builder" })).content[0].text);
  assert.deepEqual(one.agents.map((a) => a.id), ["builder"]);
  assert.equal(one.totals.measured, 0.92);
  assert.equal(one.totals.reported, 0);
  const run_ = JSON.parse((await handleToolCall("usage", { execution_id: store.id })).content[0].text);
  assert.ok(run_.agents.every((a) => a.scope === store.id));
  assert.match((await handleToolCall("usage", { execution_id: "nope" })).content[0].text, /execution_id/);
  assert.match((await handleToolCall("usage", { action: "dance" })).content[0].text, /action/);
});

test("the report renders every state with a word and a mark, in plain text", () => {
  const states = ["working", "idle", "stopped", "done"].map((state) => agent({ id: `a-${state}`, state }));
  const text = renderReport(view({ agents: [...states, agent({ id: "x", stopping: true }), agent({ id: "h", where: "host", scope: "host", money: { measured: 0, reported: 3.5, estimated: 0 } })] }), { color: false, cols: 100 });
  for (const w of ["● working", "○ idle", "■ stopped", "✓ done", "■ stopping", "◇ host"]) assert.ok(text.includes(w), w);
  assert.match(text, /\$3\.50 reported/);
});
