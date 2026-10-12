import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrototypeTracker,
  CALLER,
  activePrototypeTrackers,
  destroyAllPrototypes,
  prototypeDiagnostics,
  PROTOTYPE_NOTICE,
} from "../../dist/prototypes/index.js";

const root = () => mkdtemp(join(tmpdir(), "rt-proto-tr-"));

async function mk(t, opts = {}) {
  const tr = await PrototypeTracker.create({
    sessionId: "collab-1",
    mode: "collaborate",
    participants: ["alice", "bob"],
    assessorIsCaller: false,
    public: false,
    openBrowser: false,
    screenshots: false,
    root: await root(),
    ...opts,
  });
  t.after(() => tr.close("ended"));
  return tr;
}

const webBlock = (title = "Inline coupon field", extra = "") =>
  `<prototype title="${title}" kind="web"${extra}>\n<file path="index.html">\n<!doctype html><h1>${title}</h1><button>Apply</button>\n</file>\n` +
  `<file path="app.js">document.querySelector("button").onclick = () => {};</file>\n` +
  `<demo>Impatient user taps twice. Drunk user mistypes. Expert pastes.</demo>\n</prototype>`;
const codeBlock = (title = "Coupons table", extra = "") =>
  `<prototype title="${title}" kind="code"${extra}>\n<file path="schema.sql">CREATE TABLE coupons (code text primary key);</file>\n</prototype>`;

const status = async (url) => (await fetch(url)).status;
const protoDirs = (tr) => (existsSync(tr.sessionDir) ? readdirSync(tr.sessionDir).filter((n) => /^P\d+v\d+$/.test(n)) : []);

test("tracker: 2-agent flow — propose, assess (destroyed from disk), SHORTLIST", async (t) => {
  const tr = await mk(t);
  assert.match(tr.boardUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(await status(tr.boardUrl), 200);

  const r1 = await tr.onTurn(0, `Here is my idea.\n\n${webBlock()}\n\nThoughts?`, 1);
  assert.equal(r1.created.label, "P1 v1");
  assert.equal(r1.created.kind, "web");
  assert.equal(r1.created.url, `${tr.boardUrl}p/P1v1/`);
  assert.deepEqual(r1.destroyed, []);
  assert.deepEqual(protoDirs(tr), ["P1v1"]);
  assert.equal(await status(`${tr.boardUrl}p/P1v1/app/index.html`), 200);
  assert.equal(tr.hasLiveUnderAssessment(), true);
  assert.match(tr.statusPromptFor(1), /Verdict on P1: APPROVE\|REVISE\|REJECT/);
  assert.match(tr.statusPromptFor(0), /still under assessment \(awaiting verdicts from bob\)/);
  assert.equal(tr.historyView("anything", 1), "anything", "a live prototype stays in full");

  const r2 = await tr.onTurn(1, "Some discussion.\n".repeat(50) + "**Verdict on P1:** REVISE — the button is too small", 2);
  assert.deepEqual(r2.destroyed, ["P1 v1"]);
  assert.deepEqual(protoDirs(tr), [], "sandbox dir removed immediately");
  assert.equal(await status(`${tr.boardUrl}p/P1v1/`), 410);
  assert.equal(await status(`${tr.boardUrl}p/P1v1/app/index.html`), 410);
  assert.equal(tr.hasLiveUnderAssessment(), false);
  const prompt = tr.statusPromptFor(0);
  assert.match(prompt, /has been assessed and destroyed/);
  assert.match(prompt, /bob: REVISE — the button is too small/);
  assert.match(prompt, /Decision on P1: REVISE\|SCRAP\|SHORTLIST/);
  assert.equal(tr.statusPromptFor(1), "");
  assert.ok(tr.historyView(webBlock(), 1).includes("<prototype"), "undecided: proposer may still need the source");

  await tr.onTurn(0, "Decision on P1: SHORTLIST — worth showing", 3);
  const stub = tr.historyView(`before\n${webBlock()}\nafter`, 1);
  assert.equal(
    stub,
    'before\n[Prototype P1 v1 "Inline coupon field" (web, 2 files) — destroyed after assessment; verdicts: bob REVISE; decision: SHORTLIST]\nafter'
  );
  const out = tr.outcomesMarkdown();
  assert.match(out, /## Prototype outcomes/);
  assert.match(out, /\*\*P1 v1\*\* · alice · web · "Inline coupon field"/);
  assert.match(out, /## Shortlist for the human/);
  assert.match(out, /<!doctype html><h1>Inline coupon field<\/h1>/, "shortlist carries the full source");
  assert.match(out, /The session is complete: the human may now give feedback on these proposals\.$/);

  const sum = tr.takeCallSummary();
  assert.equal(sum.board_url, tr.boardUrl);
  assert.deepEqual(sum.live, []);
  assert.deepEqual(sum.destroyed_this_call, ["P1 v1"]);
  assert.equal(sum.notice, PROTOTYPE_NOTICE);
  assert.deepEqual(tr.takeCallSummary().destroyed_this_call, [], "drained");
});

test("tracker: SCRAP and REVISE -> v2 (the older version becomes revised)", async (t) => {
  const tr = await mk(t);
  await tr.onTurn(0, codeBlock(), 1);
  await tr.onTurn(1, "Verdict on P1: REVISE — add an expiry column", 2);
  const r3 = await tr.onTurn(0, `Decision on P1: REVISE — adding expiry\n\n${codeBlock("Coupons table v2", ' revises="P1"')}`, 3);
  assert.equal(r3.created.label, "P1 v2");
  assert.equal(r3.created.version, 2);
  assert.match(tr.historyView(codeBlock(), 1), /decision: REVISE \(superseded by P1 v2\)/);
  assert.ok(tr.historyView(codeBlock("x"), 3).includes("<prototype"), "v2 is live");
  assert.equal(tr.takeCallSummary().live[0].label, "P1 v2");

  await tr.onTurn(1, "Verdict on P1 v2: APPROVE — good", 4);
  await tr.onTurn(0, "Decision on P1: SCRAP — we found a simpler way", 5);
  assert.match(tr.historyView(codeBlock(), 3), /decision: SCRAP/);
  const out = tr.outcomesMarkdown();
  assert.match(out, /\*\*P1 v1\*\*.*status: revised \(superseded by P1 v2\)/);
  assert.match(out, /\*\*P1 v2\*\*.*decision: SCRAP.*status: scrapped/);
  assert.match(out, /None of the prototypes were shortlisted\./);
  assert.ok(!out.includes("CREATE TABLE"), "non-shortlisted source is not rendered");
});

test("tracker: 3-agent flow — destroyed only after every other agent has taken a turn", async (t) => {
  const tr = await mk(t, { participants: ["defender", "attacker 1", "attacker 2"], mode: "waffle-house" });
  await tr.onTurn(0, webBlock(), 1);
  const r2 = await tr.onTurn(1, "Verdict on P1: APPROVE — clear", 2);
  assert.deepEqual(r2.destroyed, []);
  assert.deepEqual(protoDirs(tr), ["P1v1"]);
  assert.deepEqual(tr.takeCallSummary().live[0].awaiting_verdicts_from, ["attacker 2"]);
  const r3 = await tr.onTurn(2, "I have no opinion on the prototype.", 3);
  assert.deepEqual(r3.destroyed, ["P1 v1"]);
  assert.deepEqual(protoDirs(tr), []);
  const prompt = tr.statusPromptFor(0);
  assert.match(prompt, /attacker 1: APPROVE — clear/);
  assert.match(prompt, /attacker 2: UNCLEAR/);
  // A REVISE decision without a valid block keeps the prototype awaiting a decision.
  await tr.onTurn(0, "Decision on P1: REVISE — will do", 4);
  assert.match(tr.statusPromptFor(0), /You decided REVISE on P1 but your turn had no valid <prototype revises="P1"> block/);
  assert.match(tr.statusPromptFor(0), /Decide now/);
  // A block without revises= while a REVISE is pending counts as the revision.
  const r5 = await tr.onTurn(0, `Decision on P1: REVISE — bigger button\n${webBlock("Bigger")}`, 5);
  assert.equal(r5.created.label, "P1 v2");
});

test("tracker: meeting — the caller assesses; caller blocks are ignored", async (t) => {
  const tr = await mk(t, { sessionId: "meeting-1", mode: "standard", participants: ["cfo"], assessorIsCaller: true });
  assert.equal((await tr.onTurn(CALLER, webBlock("from the caller"), 1)).created, undefined);
  const r = await tr.onTurn(0, webBlock(), 2);
  assert.equal(r.created.label, "P1 v1");
  assert.match(tr.statusPromptFor(CALLER), /Verdict on P1/);
  assert.deepEqual(tr.takeCallSummary().live[0].awaiting_verdicts_from, ["caller"]);
  const r2 = await tr.onTurn(CALLER, "Looks good.\nVerdict on P1: APPROVE — ship it", 3);
  assert.deepEqual(r2.destroyed, ["P1 v1"]);
  assert.match(tr.statusPromptFor(0), /caller: APPROVE — ship it/);
  await tr.onTurn(0, "Decision on P1: SHORTLIST — approved", 4);
  assert.match(tr.outcomesMarkdown(), /verdicts: caller APPROVE \(ship it\)/);
});

test("tracker: one turn can both give a verdict and propose", async (t) => {
  const tr = await mk(t);
  await tr.onTurn(0, webBlock(), 1);
  const r2 = await tr.onTurn(1, `Verdict on P1: REJECT — wrong problem\n\nInstead:\n${codeBlock()}`, 2);
  assert.deepEqual(r2.destroyed, ["P1 v1"]);
  assert.equal(r2.created.label, "P2 v1");
  assert.deepEqual(protoDirs(tr), ["P2v1"]);
  const r3 = await tr.onTurn(0, "Decision on P1: SCRAP — fair\nVerdict on P2: APPROVE — simpler", 3);
  assert.deepEqual(r3.destroyed, ["P2 v1"]);
  assert.match(tr.historyView(webBlock(), 1), /decision: SCRAP/);
  assert.match(tr.statusPromptFor(1), /alice: APPROVE — simpler/);
});

test("tracker: invalid blocks and invalid revisions are rejected with a remembered error", async (t) => {
  const tr = await mk(t);
  const bad = `<prototype title="x" kind="code"><file path="../etc/passwd">x</file></prototype>`;
  const r = await tr.onTurn(0, `try\n${bad}`, 1);
  assert.equal(r.created, undefined);
  assert.match(r.rejected, /invalid file path/);
  assert.match(tr.statusPromptFor(0), /Your last prototype block was rejected: invalid file path/);
  assert.equal(tr.historyView(`try\n${bad}`, 1), "try\n[Prototype block rejected: " + r.rejected + "]");
  assert.deepEqual(protoDirs(tr), []);

  await tr.onTurn(1, codeBlock(), 2); // bob proposes P1 (alice's error cleared on her next turn)
  const r3 = await tr.onTurn(0, codeBlock("mine", ' revises="P1"'), 3);
  assert.match(r3.rejected, /proposed by bob/);
  // alice's turn 3 also assessed P1 (UNCLEAR), so it is destroyed and bob may revise it ...
  const r4 = await tr.onTurn(1, codeBlock("again", ' revises="P1"'), 4);
  assert.equal(r4.created.label, "P1 v2");
  // ... but not while the new version is still under assessment.
  const r5 = await tr.onTurn(1, codeBlock("again and again", ' revises="P1"'), 5);
  assert.match(r5.rejected, /still under assessment/);
  const r6 = await tr.onTurn(0, codeBlock("x", ' revises="P7"'), 6);
  assert.match(r6.rejected, /no prototype P7/);
});

test("tracker: TTL expiry destroys an unassessed prototype", async (t) => {
  const tr = await mk(t, { ttlMs: 40 });
  await tr.onTurn(0, webBlock(), 1);
  assert.deepEqual(protoDirs(tr), ["P1v1"]);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(protoDirs(tr), []);
  assert.equal(tr.hasLiveUnderAssessment(), false);
  assert.equal(await status(`${tr.boardUrl}p/P1v1/`), 410);
  assert.deepEqual(tr.takeCallSummary().destroyed_this_call, ["P1 v1"]);
  assert.match(tr.historyView(webBlock(), 1), /destroyed when its time limit ran out/);
  assert.match(tr.outcomesMarkdown(), /status: expired/);
  // The proposer may still revise an expired prototype.
  assert.equal((await tr.onTurn(0, webBlock("again", ' revises="P1"'), 2)).created.label, "P1 v2");
});

test("tracker: close() destroys live artifacts, removes the session dir, is idempotent", async (t) => {
  const tr = await mk(t, { participants: ["a", "b", "c"] });
  await tr.onTurn(0, codeBlock("one"), 1);
  await tr.onTurn(1, `Verdict on P1: APPROVE\n${codeBlock("two")}`, 2);
  await tr.onTurn(2, "Verdict on P1: APPROVE\nVerdict on P2: REJECT — no", 3);
  await tr.onTurn(0, "Decision on P1: SHORTLIST — yes", 4);
  // P1 shortlisted, P2 live (awaiting a), nothing else
  assert.ok(existsSync(tr.sessionDir));
  const url = tr.boardUrl;
  assert.ok(activePrototypeTrackers().includes(tr));
  await Promise.all([tr.close("ended"), tr.close("ended")]);
  await tr.close("shutdown");
  assert.equal(tr.closed, true);
  assert.equal(existsSync(tr.sessionDir), false);
  assert.ok(!activePrototypeTrackers().includes(tr));
  await assert.rejects(() => fetch(url));
  assert.deepEqual(tr.takeCallSummary().destroyed_this_call.at(-1), "P2 v1");
  const out = tr.outcomesMarkdown();
  assert.match(out, /\*\*P2 v1\*\*.*status: closed at session end/);
  assert.match(out, /### P1 v1 — one/);
  assert.match(out, /CREATE TABLE/, "the shortlist survives close");
  // Turns after close are ignored, never thrown.
  assert.deepEqual(await tr.onTurn(0, codeBlock(), 5), { destroyed: [], attachments: [] });
  tr.closeSync();
});

test("tracker: public view — Markdown reference, redacted source, never a local address", async (t) => {
  const tr = await mk(t, { public: true, participants: ["/home/someone/agents/cfo.md", "skeptic"] });
  const key = "sk-ant-" + "abcdefghijklmnop1234";
  const block =
    `<prototype title="Coupon" kind="web"><file path="index.html"><!doctype html>` +
    `<script>fetch("http://localhost:3000/api"); const k = "${key}"; const ip = "127.0.0.1";</script></file>` +
    `<demo>Expert user</demo></prototype>`;
  const text = `My proposal, viewable at ${"http://127.0.0.1:"}${new URL(tr.boardUrl).port}/p/P1v1/ :\n${block}`;
  const r = await tr.onTurn(0, text, 1);
  assert.equal(r.created.label, "P1 v1");
  assert.deepEqual(r.attachments, [], "screenshots disabled in this test");
  const pub = tr.publicView(text, 1);
  assert.ok(!/127\.0\.0\.1|localhost/i.test(pub), pub);
  assert.ok(!pub.includes(tr.boardUrl));
  assert.ok(!pub.includes(key), "file content is redacted before materializing");
  assert.match(pub, /\*\*Prototype P1 v1 — Coupon\*\*/);
  assert.match(pub, /proposed by cfo/);
  assert.match(pub, /```html/);
  assert.ok(!pub.includes("<prototype"));
  // Board URLs are scrubbed even from text without a prototype.
  const plain = tr.publicView(`see ${tr.boardUrl} and http://localhost:${new URL(tr.boardUrl).port}/p/x`, 99);
  assert.ok(!plain.includes("127.0.0.1") && !plain.includes("localhost"), plain);
  assert.equal(tr.publicView("no prototype here", 98), "no prototype here");
});

test("registry: destroyAllPrototypes closes every open tracker; diagnostics", async (t) => {
  const a = await mk(t);
  const b = await mk(t, { sessionId: "collab-2" });
  await a.onTurn(0, codeBlock(), 1);
  const d = prototypeDiagnostics();
  assert.ok(d.active_boards >= 2);
  assert.equal(typeof d.dir, "string");
  assert.equal(typeof d.ttl_ms, "number");
  assert.equal(d.open_browser, false);
  await destroyAllPrototypes("shutdown");
  assert.equal(a.closed && b.closed, true);
  assert.equal(existsSync(a.sessionDir), false);
  assert.equal(activePrototypeTrackers().length, 0);
});

test("tracker: refuses a root inside a git work tree", async () => {
  const repo = await root();
  await (await import("node:fs/promises")).mkdir(join(repo, ".git"));
  await assert.rejects(
    () => PrototypeTracker.create({ sessionId: "s", mode: "collaborate", participants: ["a", "b"], assessorIsCaller: false, public: false, openBrowser: false, root: join(repo, "p") }),
    /git work tree/
  );
});
