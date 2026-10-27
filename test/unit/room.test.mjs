// Socket tests: run on a host that permits loopback listeners.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { startRoom } from "../../dist/table/room.js";
import { replayDuel } from "../../dist/table/replay.js";
import { APP_CSP } from "../../dist/prototypes/board.js";
import { inlineProblems } from "./helpers.mjs";
import { ROOM_CSS, ROOM_JS } from "../../dist/table/room-assets.js";

const fixture = new URL("../../examples/duel/demo.json", import.meta.url);
function rawRequest(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path, headers }, response => {
      let text = ""; response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on("error", reject); request.end();
  });
}

test("room capability checks, strict shell CSP, and recorded prototype serving", async t => {
  const room = await startRoom({ open: false, hold: false });
  t.after(() => room.close());
  const base = new URL(room.url);
  assert.equal(base.hostname, "127.0.0.1");
  assert.equal((await fetch(new URL("/state.json", base))).status, 404);
  assert.equal((await fetch(new URL("/wrong-token/state.json", base))).status, 404);
  assert.equal((await rawRequest(base, base.pathname + "state.json", { Host: "invalid.example" })).status, 421);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.ok(!page.headers.get("content-security-policy").includes("unsafe-inline"));
  assert.deepEqual(inlineProblems(await page.text()), []);
  assert.equal((await fetch(new URL("room.js", base))).status, 200);
  await replayDuel(fixture, room.observer, { speed: 100000 });
  const state = await (await fetch(new URL("state.json", base))).json();
  assert.equal(state.prototypes.length, 2);
  assert.equal(state.assessments.length, 4);
  assert.equal(state.dissents.length, 1);
  assert.equal(state.end.winner, "A");
  const archive = JSON.parse(await readFile(fixture, "utf8"));
  assert.equal(state.usage.totalCostUsd, archive.events.findLast(e => e.type === "usage").totalCostUsd);
  assert.ok(!JSON.stringify(state).includes("<script>"));
  for (const team of ["A", "B"]) {
    const response = await fetch(new URL(`p/${team}/index.html`, base));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-security-policy"), APP_CSP);
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(await response.text(), archive.prototypes.findLast(p => p.team === team).files[0].content);
  }
});

test("room rejects traversal, encoded separators, and files not recorded for the prototype", async t => {
  const room = await startRoom({ hold: false });
  t.after(() => room.close());
  await replayDuel(fixture, room.observer, { speed: 100000 });
  const base = new URL(room.url);
  for (const suffix of ["p/A/secret.txt", "p/C/index.html", "p/A/../index.html", "p/A/../../state.json", "p/A/%2e%2e/%2e%2e/state.json", "p/A/%2findex.html", "p/A/%252e%252e/index.html", "p/A/index.html/extra", "p/A/%", "p/A/%5cindex.html"]) {
    const response = await rawRequest(base, base.pathname + suffix);
    assert.equal(response.status, 404, suffix);
  }
  assert.throws(() => room.setPrototypeFiles("A", [{ path: "../secret", content: "no" }]), /Invalid/);
  assert.equal((await fetch(new URL("p/A/index.html", base), { method: "HEAD" })).status, 200);
  assert.equal((await fetch(new URL("state.json", base), { method: "POST" })).status, 405);
});

test("room preserves completed games until closed and close is idempotent", async () => {
  const room = await startRoom({ hold: false });
  try {
    await replayDuel(fixture, room.observer, { speed: 100000 });
    assert.equal((await fetch(new URL("p/A/index.html", room.url))).status, 200);
    assert.equal((await fetch(new URL("p/B/index.html", room.url))).status, 200);
    await room.close(); await room.close();
    await assert.rejects(fetch(room.url));
  } finally { await room.close(); }
});

test("default room hold registers Ctrl-C cleanup and close releases it", async () => {
  const before = process.listenerCount("SIGINT");
  const room = await startRoom();
  try {
    await room.observer.onEvent({ type: "end", winner: "tie", tally: { A: 0, B: 0 } });
    assert.equal(process.listenerCount("SIGINT"), before + 1);
  } finally { await room.close(); }
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("room script words unpriced spend as tokens with no price", async () => {
  const { ROOM_JS } = await import("../../dist/table/room-assets.js");
  const start = ROOM_JS.indexOf("const spendText");
  const spendText = new Function(`${ROOM_JS.slice(start, ROOM_JS.indexOf("\n", start))}; return spendText;`)();
  assert.equal(spendText(0, 41200, false), "41.2k tok (no price)");
  assert.equal(spendText(0.0123, 41200, true), "$0.0123 + 41.2k tok unpriced");
  assert.equal(spendText(0.5, 0, true), "$0.5000");
});

test("live frames render as a scaled desktop preview with classes only, and the footer spend never reads below the panes", () => {
  assert.match(ROOM_CSS, /\.live\.scaled iframe\{[^}]*width:calc\(100% \/ var\(--s\)\)[^}]*transform:scale\(var\(--s\)\)[^}]*transform-origin:top left/);
  assert.match(ROOM_CSS, /\.live\.scaled\{[^}]*aspect-ratio/);
  assert.match(ROOM_CSS, /@media\(min-width:1266px\) and \(max-width:1495px\)\{\.live\.scaled\{--s:\.6\}\}/);
  assert.match(ROOM_JS, /classList\.toggle\("scaled", web && !selections\.has\(team\)\)/);
  assert.ok(!/\.style\b|setAttribute\("style"/.test(ROOM_JS), "the room script sets no inline styles");
  assert.match(ROOM_JS, /Math\.max\(state\.usage\.totalCostUsd \|\| 0, teamSpend\)/);
  assert.match(ROOM_JS, /frame\.setAttribute\("sandbox", "allow-scripts allow-forms allow-modals"\)/);
});
