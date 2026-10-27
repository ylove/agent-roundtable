import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalObserver, createNdjsonObserver, clean, visibleWidth } from "../../dist/table/terminal.js";
const ts = "2026-10-26T12:00:00Z";
const seats = ["A", "B"].map(team => ({ id: team, team, name: "Builder " + team, provider: "test", model: "model" }));
const metric = extra => ({ elapsedMs: 130000, stagesDone: 3, stagesTotal: 4, inputTokens: 14000, outputTokens: 4200, costUsd: 0, unpricedTokens: 18200, turns: 4, failedTurns: 1, versions: 3, rewrites: 1, validationFailures: 1, pageErrors: 2, toolCalls: 1, ...extra });
const metrics = { A: metric(), B: metric({ stagesDone: 2, elapsedMs: 90000 }) };
const events = [
  { type: "start", id: "test", mode: "duel", topic: "Build together", seats, startedAt: ts },
  ...seats.map(seat => ({ type: "turn", round: "concept", seat, text: ("Team " + seat.team + " has a useful idea. ").repeat(8), ts })),
  { type: "metrics", teams: metrics, ts },
  { type: "stage", team: "A", stage: 2, of: 4, name: "Screens", status: "done", version: 2, ts },
  { type: "prototype", team: "B", seat: seats[1], ok: true, title: "A polished build", version: 2, stage: 2, files: [{ path: "index.html", bytes: 30 }] },
  { type: "assessment", team: "A", judge: { ...seats[0], id: "j", name: "Judge", team: "judge" }, verdict: "APPROVE", reason: "Clear flow" },
  { type: "control", action: "stopped", by: "room", ts },
  { type: "control", action: "resumed", by: "terminal", ts },
  { type: "decision", status: "awaiting", ts },
  { type: "decision", status: "made", by: "human", winner: "A", ts },
  { type: "end", winner: "A", tally: { A: 2, B: 0 }, decidedBy: "human", chosen: { team: "A", version: 2, dir: "duels/test/chosen", files: ["index.html"] }, metrics },
];
function render({ width = 103, isTTY = true, env = {}, layout = "auto" } = {}, stream = events) {
  let text = ""; const output = { isTTY, columns: width, write: s => { text += s; } };
  const observer = createTerminalObserver({ output, env, layout });
  stream.forEach(e => observer.onEvent(e)); return text;
}
for (const env of [{}, { NO_COLOR: "1" }]) test("split columns have exact visible padding with " + (env.NO_COLOR ? "NO_COLOR" : "ANSI colour"), () => {
  const text = render({ env });
  const rows = text.split("\n").filter(l => l.includes(" │ "));
  assert.ok(rows.length > 20);
  for (const row of rows) {
    const [left, right] = row.split(" │ ");
    assert.equal(visibleWidth(left), 50, JSON.stringify(row)); assert.equal(visibleWidth(right), 50, JSON.stringify(row));
  }
  const a = rows.find(r => clean(r).includes("● Builder A")), b = rows.find(r => clean(r).includes("● Builder B"));
  assert.equal(clean(a).split(" │ ")[1].trim(), ""); assert.equal(clean(b).split(" │ ")[0].trim(), "");
  assert.match(clean(text), /▸ Stage 2\/4 Screens · done \(v2\)/);
  assert.match(clean(text), /A 3\/4 · 2m10s · 18.2k tok\s+│ B 2\/4/);
  for (const label of ["Tokens:", "Cost:", "Time:", "Versions:", "Rewrites:", "Errors:"]) assert.ok(rows.some(r => r.split(" │ ").every(c => clean(c).includes(label))), label);
  assert.match(clean(text), /18.2k tok \(no price\)/);
  for (const line of text.split("\n").filter(l => /Judge →|Stopped by|^Resumed|Waiting for you|You chose|Winner:|Chosen by you|Chosen artifact:/.test(clean(l)))) assert.ok(!line.includes("│"));
  if (env.NO_COLOR) assert.doesNotMatch(text, /\x1b/); else assert.match(text, /\x1b\[/);
});

test("split non-TTY output, odd widths, long words and wide glyphs fit their columns", () => {
  for (const width of [100, 101, 120, 160]) {
    const stream = [{ type: "turn", seat: seats[0], round: "build", text: "界".repeat(120) + " " + "x".repeat(110) + " é", ts }];
    const text = render({ width, isTTY: false, layout: "split" }, stream);
    assert.doesNotMatch(text, /\x1b/);
    for (const row of text.trimEnd().split("\n").slice(0, -1)) {
      const [a, b] = row.split(" │ "); assert.equal(visibleWidth(a), Math.floor((width - 3) / 2)); assert.equal(visibleWidth(b), Math.floor((width - 3) / 2));
    }
  }
  assert.equal(visibleWidth("\x1b[31mhello\x1b[0m"), 5); assert.equal(visibleWidth("界é"), 3); assert.equal(visibleWidth("✅👩‍💻"), 4);
});

test("stack and narrow auto/split fallback tag team lines and include every new event", () => {
  for (const options of [{ layout: "stack", width: 120 }, { width: 99 }, { width: 120, isTTY: false }, { layout: "split", width: 70 }]) {
    const text = clean(render(options));
    assert.doesNotMatch(text, /│/); assert.match(text, /\[A\] ● Builder A/); assert.match(text, /\[B\] ● Builder B/);
    assert.match(text, /\[A\] ▸ Stage 2\/4 Screens · done \(v2\)/);
    assert.match(text, /\[B\] Prototype B:/);
    assert.match(text, /Stopped by room\nResumed/);
    assert.match(text, /Waiting for you to choose the winner in the room\./); assert.match(text, /You chose Team A\./);
    assert.match(text, /Chosen by you/); assert.match(text, /Chosen artifact: duels\/test\/chosen/);
  }
  const text = render({ layout: "stack" }); assert.match(text, /\x1b\[36m\[A\]/); assert.match(text, /\x1b\[35m\[B\]/);
});

test("judges, decisions, dissents and closing statements remain full width", () => {
  const stream = [
    { type: "turn", seat: { ...seats[0], team: "judge", id: "judge" }, round: "judge", text: "Advice", ts },
    { type: "dissent", seat: seats[0], team: "A", text: "Concern" },
    { type: "turn", seat: seats[0], round: "closing", text: "Closing", ts },
    { type: "control", action: "stopped", by: "terminal", ts },
    { type: "end", winner: "tie", tally: { A: 1, B: 1 }, decidedBy: "judges" },
  ];
  const text = clean(render({}, stream)); assert.doesNotMatch(text, /│/); assert.match(text, /Stopped by terminal/); assert.match(text, /Judges' tally A 1 \/ B 1/);
});

test("NDJSON passes the extended synthetic stream through unchanged", () => {
  let text = ""; const observer = createNdjsonObserver({ write: s => { text += s; } });
  events.forEach(e => observer.onEvent(e)); assert.deepEqual(text.trim().split("\n").map(s => JSON.parse(s)), events);
});

test("split metrics keep logical rows aligned when mixed-price spend wraps", () => {
  const long = { A: metric({ costUsd: 1234567890123456789, unpricedTokens: 182000 }), B: metric({ costUsd: .05, unpricedTokens: 0 }) };
  const text = clean(render({ width: 100 }, [{ type: "end", winner: "A", tally: { A: 1, B: 0 }, metrics: long }]));
  const rows = text.split("\n").filter(r => r.includes(" │ "));
  assert.ok(rows.length > 7);
  const time = rows.find(r => r.includes("Time:"));
  assert.ok(time.split(" │ ").every(c => c.includes("Time:")));
  assert.ok(rows.filter(r => r.includes("(no price)")).every(r => r.split(" │ ")[1].trim() === ""));
});
