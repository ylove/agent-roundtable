import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrototypeTracker,
  CALLER,
  activePrototypeTrackers,
  buildPrototypeDirective,
  destroyAllPrototypes,
  prototypeDiagnostics,
  PROTOTYPE_NOTICE,
} from "../../dist/prototypes/index.js";

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const root = async () => {
  const d = await mkdtemp(join(tmpdir(), "rt-proto-tr-"));
  made.push(d);
  return d;
};

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

async function waitFor(condition, description) {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("tracker: 2-agent flow — propose, assess (destroyed from disk), SHORTLIST", async (t) => {
  const tr = await mk(t);
  assert.match(tr.boardUrl, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}\/$/);
  assert.equal(await status(tr.boardUrl), 200);
  assert.equal(await status(new URL(tr.boardUrl).origin + "/"), 404, "nothing is served without the token");

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
  assert.equal(tr.historyView(`try\n${bad}`, 1), "try\n[Prototype block not accepted: " + r.rejected + "]");
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
  // Expiry updates state before awaiting asynchronous directory removal.
  await waitFor(() => !tr.hasLiveUnderAssessment() && protoDirs(tr).length === 0, "TTL expiry and artifact removal");
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

const views = (tr, text, key) => [tr.publicView(text, key), tr.historyView(text, key)];

test("views: a cut-off (unclosed) block never goes out raw", async (t) => {
  const tr = await mk(t, { public: true });
  const cut = `Here it is\n<prototype title="x" kind="web">\n<file path="index.html"><h1>${"BIG ".repeat(5000)}</h1></file>\n`;
  const r = await tr.onTurn(0, cut, 1);
  assert.match(r.rejected, /not closed/);
  const [pub, hist] = views(tr, cut, 1);
  assert.equal(hist, `Here it is\n[Prototype block not accepted: ${r.rejected}]`);
  assert.equal(pub, `Here it is\n_[Prototype block not accepted: ${r.rejected}]_`);
  // Cut off inside the opening tag, or mid-line: still scrubbed.
  for (const text of [`Look: <prototype title="half`, `Look: <prototype kind="web"><file path="a.html">secret`]) {
    for (const v of views(tr, text, 2)) {
      assert.ok(!v.includes("<prototype") && !v.includes("secret"), v);
      assert.match(v, /^Look: _?\[Prototype block not accepted: (incomplete|not processed)\]_?$/);
    }
  }
  // Prose mentions are not blocks and stay as they are.
  for (const text of ["I will emit a `<prototype>` block next turn.", "A bare <prototype> mention, no files."]) {
    assert.equal(tr.historyView(text, 3), text);
    assert.equal(tr.publicView(text, 3), text);
  }
});

test("views: rejected, extra, unprocessed and post-close blocks become placeholders", async (t) => {
  const tr = await mk(t, { public: true });
  // Rejected for size: the 200 KB block never reaches either view.
  const big = `before <prototype title="y" kind="web"><file path="index.html">${"Z".repeat(200000)}</file></prototype> after`;
  const r = await tr.onTurn(0, big, 1);
  assert.match(r.rejected, /limit is/);
  assert.equal(tr.historyView(big, 1), `before [Prototype block not accepted: ${r.rejected}] after`);
  assert.equal(tr.publicView(big, 1), `before _[Prototype block not accepted: ${r.rejected}]_ after`);

  // Accepted block, then an extra block and a trailing cut-off block in the same turn.
  const multi = `${webBlock()}\nalso\n${codeBlock("second")}\nand\n<prototype title="third" kind="code"><file path="x.sql">TAIL-SECRET`;
  const r2 = await tr.onTurn(1, multi, 2);
  assert.equal(r2.created.label, "P1 v1");
  const hist = tr.historyView(multi, 2);
  assert.equal(hist.split("<prototype").length, 2, "only the accepted (live) block stays in full");
  assert.ok(hist.includes("[extra prototype block ignored]") && hist.includes("[Prototype block not accepted: incomplete]"));
  assert.ok(!hist.includes("TAIL-SECRET") && !hist.includes("CREATE TABLE"));
  const pub = tr.publicView(multi, 2);
  assert.ok(!pub.includes("<prototype") && !pub.includes("TAIL-SECRET") && !pub.includes("CREATE TABLE"), pub);
  assert.match(pub, /\*\*Prototype P1 v1 — Inline coupon field\*\*/);
  assert.match(pub, /_\[extra prototype block omitted\]_/);
  assert.match(pub, /_\[Prototype block not accepted: incomplete\]_$/);

  // A turn the tracker never processed (here: after close) has no record at all.
  await tr.close("ended");
  assert.deepEqual(await tr.onTurn(0, webBlock("late"), 3), { destroyed: [], attachments: [] });
  assert.equal(tr.historyView(`x ${webBlock("late")} y`, 3), "x [Prototype block not accepted: not processed] y");
  assert.equal(tr.publicView(`x ${webBlock("late")} y`, 3), "x _[Prototype block not accepted: not processed]_ y");
});

test("views: a caller's block in a meeting is never passed through", async (t) => {
  const tr = await mk(t, { sessionId: "meeting-1", mode: "standard", participants: ["cfo"], assessorIsCaller: true });
  await tr.onTurn(CALLER, `try this\n${webBlock("from the caller")}`, 1);
  assert.equal(tr.historyView(`try this\n${webBlock("from the caller")}`, 1), "try this\n[Prototype block not accepted: not processed]");
});

test("names: a repeated persona is suffixed in prompts, board, outcomes, summary and public views", async (t) => {
  const tr = await mk(t, { participants: ["sample", "sample"] });
  await tr.onTurn(0, webBlock(), 1);
  const live = tr.takeCallSummary().live[0];
  assert.equal(live.proposer, "sample");
  assert.deepEqual(live.awaiting_verdicts_from, ["sample #2"]);
  assert.match(tr.statusPromptFor(0), /awaiting verdicts from sample #2\)/);
  assert.match(tr.statusPromptFor(1), /by sample\. Give a line/);
  const st = await (await fetch(`${tr.boardUrl}state.json`)).json();
  assert.deepEqual(st.session.participants, ["sample", "sample #2"]);
  assert.deepEqual(st.prototypes[0].awaiting, ["sample #2"]);
  await tr.onTurn(1, "Verdict on P1: REJECT — no", 2);
  assert.match(tr.statusPromptFor(0), /- sample #2: REJECT — no/);
  await tr.onTurn(0, "Decision on P1: SCRAP — fine", 3);
  assert.match(tr.outcomesMarkdown(), /\*\*P1 v1\*\* · sample · web · "Inline coupon field" · verdicts: sample #2 REJECT \(no\)/);

  // Public labels that collide (same agent file name in two directories) are suffixed too.
  const pub = await mk(t, { public: true, participants: ["/x/agents/cfo.md", "/y/agents/cfo.md"] });
  await pub.onTurn(1, webBlock(), 1);
  assert.match(pub.publicView(webBlock(), 1), /proposed by cfo #2_/);
  assert.equal(pub.takeCallSummary().live[0].proposer, "/y/agents/cfo.md");
});

test("close during materialize: the prototype is never registered as live and nothing stays on disk", async (t) => {
  const files = Array.from({ length: 10 }, (_, i) => `<file path="f${i}.html">${"x".repeat(9000)}</file>`).join("");
  const block = `<prototype title="race" kind="web" entry="f0.html">${files}</prototype>`;
  for (let yields = 0; yields < 30; yields++) {
    const tr = await mk(t);
    const turn = tr.onTurn(0, block, 1);
    for (let i = 0; i < yields; i++) await new Promise((r) => setImmediate(r));
    await tr.close("ended");
    const r = await turn;
    assert.equal(tr.hasLiveUnderAssessment(), false, `yields ${yields}`);
    assert.deepEqual(tr.takeCallSummary().live, [], `yields ${yields}`);
    if (r.created) assert.match(tr.outcomesMarkdown(), /status: closed at session end/);
    await waitFor(() => !existsSync(tr.sessionDir), `yields ${yields}: session dir removal`);
    assert.equal(existsSync(tr.sessionDir), false, `yields ${yields}: session dir removed`);
  }
});

test("config: ROUNDTABLE_PROTOTYPE_TTL_MS has a one-minute floor and warns once, on stderr only", () => {
  const config = new URL("../../dist/config.js", import.meta.url).href;
  const run = (value) => {
    const env = { ...process.env };
    if (value === undefined) delete env.ROUNDTABLE_PROTOTYPE_TTL_MS;
    else env.ROUNDTABLE_PROTOTYPE_TTL_MS = value;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const c = await import(${JSON.stringify(config)}); console.log(c.PROTOTYPE_TTL_MS);`], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { ttl: Number(r.stdout.trim()), stdout: r.stdout, warnings: r.stderr.split("\n").filter((l) => l.includes("ROUNDTABLE_PROTOTYPE_TTL_MS")) };
  };
  const unset = run(undefined);
  assert.deepEqual([unset.ttl, unset.warnings.length], [1_800_000, 0]);
  const ok = run("120000");
  assert.deepEqual([ok.ttl, ok.warnings.length], [120_000, 0]);
  for (const [value, want] of [["5", 60_000], ["59999", 60_000], ["0", 60_000], ["abc", 1_800_000], ["-1", 1_800_000], ["1e9", 1_800_000], ["99999999999", 2_147_483_647]]) {
    const r = run(value);
    assert.equal(r.ttl, want, value);
    assert.equal(r.warnings.length, 1, `${value}: one warning`);
    assert.match(r.stdout, /^\d+\n$/, "nothing but the value on stdout (the MCP channel)");
  }
});

test("directive: classic scripts only, inline data, no storage, compact blocks", () => {
  const d = buildPrototypeDirective({ assessorIsCaller: false, public: false });
  assert.match(d, /sandboxed, network-restricted frame/);
  assert.match(d, /classic <script> tags only \(no type="module", no ES import\)/);
  assert.match(d, /inline any data \(no fetch or XHR of other files\)/);
  assert.match(d, /no localStorage, sessionStorage or cookies/);
  assert.match(d, /at most 100 KB in total/);
  assert.match(d, /aim for under about 20 KB\): a block cut off before <\/prototype> is rejected/);
});
