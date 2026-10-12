import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrototypeBlock,
  parseVerdictFor,
  parseDecisionFor,
  replacePrototypeBlock,
  scrubPrototypeBlocks,
  validatePath,
  cleanFileContent,
  isMermaidSource,
} from "../../dist/prototypes/parse.js";

const block = (attrs, files, demo = "") =>
  `<prototype ${attrs}>\n${files.map(([p, c]) => `<file path="${p}">\n${c}\n</file>`).join("\n")}\n${demo ? `<demo>${demo}</demo>\n` : ""}</prototype>`;

const parse = (text) => parsePrototypeBlock(text);
const errOf = (text) => {
  const r = parse(text);
  assert.equal(r.found, true);
  assert.equal(r.ok, false, `expected a validation error, got ${JSON.stringify(r)}`);
  return r.error;
};

test("parse: no block means found=false; prose mentions are not blocks", () => {
  assert.equal(parse("Just talking. No prototype here.").found, false);
  assert.equal(parse("I will emit a `<prototype>` block next turn.").found, false);
  assert.equal(parse("").found, false);
});

test("parse: attributes in any order, either quote style, case-insensitive names", () => {
  const a = parse(`<Prototype KIND='web' entry="page.html" Title='Coupon "inline" field'>\n<file path='page.html'><p>x</p></file>\n</Prototype>`);
  assert.equal(a.ok, true);
  assert.equal(a.prototype.kind, "web");
  assert.equal(a.prototype.entry, "page.html");
  assert.equal(a.prototype.title, 'Coupon "inline" field');
  const b = parse(`<prototype revises=p2 title="T" kind=code><file path="schema.sql">CREATE TABLE x (id int);</file></prototype>`);
  assert.equal(b.ok, true);
  assert.equal(b.prototype.revises, "P2");
  assert.equal(b.prototype.kind, "code");
});

test("parse: one wrapping code fence is stripped; single leading/trailing newline trimmed", () => {
  const r = parse(block('title="t" kind="web"', [["index.html", "```html\n<!doctype html>\n<p>hi</p>\n```"]]));
  assert.equal(r.ok, true);
  assert.equal(r.prototype.files[0].content, "<!doctype html>\n<p>hi</p>");
  assert.equal(cleanFileContent("\nline one\nline two\n"), "line one\nline two");
  assert.equal(cleanFileContent("\n\nkeeps one blank line\n\n"), "\nkeeps one blank line\n");
  // Content that has its own fences inside is left alone.
  const md = "```js\na()\n```\ntext\n```py\nb()\n```";
  assert.equal(cleanFileContent(md), md);
  // A longer outer fence wraps inner triple fences.
  assert.equal(cleanFileContent("````md\n# T\n```js\nx\n```\n````"), "# T\n```js\nx\n```");
});

test("parse: kind defaults by content", () => {
  assert.equal(parse(block('title="t"', [["a.css", "x{}"], ["index.html", "<p>"]])).prototype.kind, "web");
  assert.equal(parse(block('title="t"', [["flow.mmd", "flowchart TD\nA-->B"]])).prototype.kind, "diagram");
  assert.equal(parse(block('title="t"', [["draft.md", "# Hello"]])).prototype.kind, "text");
  assert.equal(parse(block('title="t"', [["note.txt", "Dear all"]])).prototype.kind, "text");
  assert.equal(parse(block('title="t"', [["main.tf", 'resource "x" "y" {}'], ["vars.tf", ""]])).prototype.kind, "code");
});

test("parse: path validation (traversal, absolute, backslashes, depth, charset, length)", () => {
  for (const bad of ["../x.html", "/etc/passwd", "a/../b.html", "a\\b.html", ".env", "a//b", "a/b/c/d/e.txt", "C:/x.txt", "a b.txt", "x/.git/config"]) {
    assert.ok(validatePath(bad), `should reject ${bad}`);
    const e = errOf(block('title="t" kind="code"', [[bad, "x"]]));
    assert.match(e, /path/i, bad);
  }
  assert.ok(validatePath("a".repeat(121)));
  for (const good of ["index.html", "src/app.js", "a/b/c/d.txt", "My_File-1.v2.sql"]) assert.equal(validatePath(good), null, good);
});

test("parse: limits — 1..10 files, <=100 KB, no duplicate paths", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, "x"]);
  assert.match(errOf(block('title="t" kind="code"', eleven)), /at most 10 files/);
  assert.match(errOf(`<prototype title="t" kind="code"><demo>d</demo></prototype>`), /at least one/);
  const big = "x".repeat(60 * 1024);
  assert.match(errOf(block('title="t" kind="code"', [["a.txt", big], ["b.txt", big]])), /100 KB/);
  assert.match(errOf(block('title="t" kind="code"', [["a.sql", "1"], ["A.sql", "2"]])), /duplicate/);
  assert.equal(parse(block('title="t" kind="code"', [["a.txt", "x".repeat(100 * 1024)]])).ok, true);
});

test("parse: web needs an html entry; diagram needs Mermaid; text needs exactly one file", () => {
  assert.match(errOf(block('title="t" kind="web"', [["app.js", "x"]])), /\.html/);
  assert.match(errOf(block('title="t" kind="web"', [["a.html", "x"], ["b.html", "y"]])), /entry/);
  assert.match(errOf(block('title="t" kind="web" entry="missing.html"', [["a.html", "x"]])), /not one of the files/);
  assert.equal(parse(block('title="t" kind="web"', [["a.html", "x"], ["index.html", "y"]])).prototype.entry, "index.html");
  assert.equal(parse(block('title="t" kind="web"', [["pages/only.html", "x"], ["s.css", ""]])).prototype.entry, "pages/only.html");

  assert.match(errOf(block('title="t" kind="diagram"', [["flow.mmd", "this is not mermaid"]])), /Mermaid/);
  assert.match(errOf(block('title="t" kind="diagram"', [["a.mmd", "graph TD\nA-->B"], ["b.mmd", "graph LR\nA-->B"]])), /exactly one/);
  assert.equal(parse(block('title="t" kind="diagram"', [["d.md", "Notes\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```"]])).ok, true);
  assert.equal(isMermaidSource("---\ntitle: x\n---\n%% c\nflowchart TD\nA-->B"), true);

  assert.match(errOf(block('title="t" kind="text"', [["a.md", "x"], ["b.md", "y"]])), /exactly one/);
  assert.match(errOf(`<prototype title="t" kind="slides"><file path="a.txt">x</file></prototype>`), /unknown kind/);
  assert.match(errOf(`<prototype title="t" kind="code" revises="banana"><file path="a.txt">x</file></prototype>`), /revises/);
});

test("parse: malformed blocks give structured errors, never throw", () => {
  assert.match(errOf("Here it is:\n<prototype title=\"t\" kind=\"code\">\n<file path=\"a.sql\">x</file>\n(no closing tag)"), /not closed/);
  assert.match(errOf(`<prototype title="t" kind="code"><file path="a.sql">x</prototype>`), /<file> element is not closed/);
  assert.doesNotThrow(() => parse("<prototype".repeat(500)));
  assert.doesNotThrow(() => parse(null));
});

test("parse: first block only, extras produce a warning; demo extracted outside files", () => {
  const t = block('title="one" kind="code"', [["a.sql", "<demo>not the demo</demo>"]], "impatient user; drunk user; expert") +
    "\n\n" + block('title="two" kind="code"', [["b.sql", "y"]]);
  const r = parse(t);
  assert.equal(r.ok, true);
  assert.equal(r.prototype.title, "one");
  assert.equal(r.prototype.demo, "impatient user; drunk user; expert");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /1 extra/);
});

test("parse: prose mention before the real block does not swallow it", () => {
  const t = "I'll use a <prototype> block below.\n\n" + block('title="real" kind="code"', [["a.sql", "x"]]);
  const r = parse(t);
  assert.equal(r.ok, true);
  assert.equal(r.prototype.title, "real");
});

test("replacePrototypeBlock: replaces the first block, optionally the extras", () => {
  const t = "before\n" + block('title="a" kind="code"', [["a.sql", "x"]]) + "\nmiddle\n" + block('title="b" kind="code"', [["b.sql", "y"]]) + "\nafter";
  const once = replacePrototypeBlock(t, "[STUB]");
  assert.ok(once.startsWith("before\n[STUB]\nmiddle\n<prototype"));
  const all = replacePrototypeBlock(t, "[STUB]", "[EXTRA]");
  assert.equal(all, "before\n[STUB]\nmiddle\n[EXTRA]\nafter");
  assert.equal(replacePrototypeBlock("no block", "[STUB]"), "no block");
});

test("verdicts: decorated lines at the END of a long turn, unicode dashes, versions, case", () => {
  const long = "Discussion line.\n".repeat(200);
  const v = parseVerdictFor(`${long}\n> - **Verdict on P1:** revise — the button is too small`, "P1");
  assert.deepEqual(v, { verdict: "REVISE", reason: "the button is too small" });
  assert.equal(parseVerdictFor("1. Verdict on P1 v2: APPROVE – fine", "P1", 2).verdict, "APPROVE");
  assert.equal(parseVerdictFor("Verdict on P1 (v2): REJECT — no", "P1", 2).verdict, "REJECT");
  assert.equal(parseVerdictFor("Verdict on `P1`: Approved - ok", "P1").verdict, "APPROVE");
  assert.equal(parseVerdictFor("### Verdict for P3: REJECTED: unsafe", "P3").reason, "unsafe");
  // A line naming another version or another id does not count.
  assert.equal(parseVerdictFor("Verdict on P1 v1: APPROVE", "P1", 2).verdict, "UNCLEAR");
  assert.equal(parseVerdictFor("Verdict on P12: APPROVE", "P1").verdict, "UNCLEAR");
  // The last valid line wins; prose without a verdict word is ignored.
  assert.equal(parseVerdictFor("Verdict on P1: REJECT — first take\n...\nVerdict on P1: APPROVE — after thinking\nThe verdict on P1 is tricky", "P1").verdict, "APPROVE");
  // Missing verdict -> UNCLEAR.
  assert.deepEqual(parseVerdictFor("I like it a lot.", "P1"), { verdict: "UNCLEAR", reason: "" });
  assert.equal(parseVerdictFor("Verdict on P1: maybe later", "P1").verdict, "UNCLEAR");
  // snake_case in reasons survives
  assert.equal(parseVerdictFor("Verdict on P1: REVISE — rename coupon_code", "P1").reason, "rename coupon_code");
});

test("scrubPrototypeBlocks: complete, extra and unclosed blocks are all replaced; mentions are kept", () => {
  const opts = { first: "[FIRST]", extra: "[EXTRA]", unclosed: "[CUT]", unclosedOnly: "[CUT-ONLY]" };
  const a = `<prototype title="a"><file path="a.sql">A</file></prototype>`;
  const b = `<prototype title="b"><file path="b.sql">B</file></prototype>`;
  assert.equal(scrubPrototypeBlocks(`x ${a} y ${b} z`, opts), "x [FIRST] y [EXTRA] z");
  assert.equal(scrubPrototypeBlocks(`x ${a} y ${b} z`, { ...opts, first: null }), `x ${a} y [EXTRA] z`);
  // A trailing unclosed block, with or without complete blocks before it.
  assert.equal(scrubPrototypeBlocks(`x ${a} y <prototype title="c"><file path="c.sql">SECRET`, opts), "x [FIRST] y [CUT]");
  assert.equal(scrubPrototypeBlocks(`x\n<prototype title="c">\n<file path="c.sql">SECRET`, opts), "x\n[CUT-ONLY]");
  // An unclosed block before a complete one (the parser uses the complete one): both are replaced.
  assert.equal(scrubPrototypeBlocks(`x <prototype title="c"><file path="c.sql">SECRET\n${a} z`, opts), "x [CUT][FIRST] z");
  // Cut inside the opening tag, or a bare tag followed by files.
  assert.equal(scrubPrototypeBlocks(`x <prototype title="hal`, opts), "x [CUT-ONLY]");
  assert.equal(scrubPrototypeBlocks(`x <prototype>\n<file path="a.html">SECRET`, opts), "x [CUT-ONLY]");
  // Mentions are not blocks.
  for (const s of ["I will emit a `<prototype>` block.", "A bare <prototype> mention.", "no block at all", ""]) {
    assert.equal(scrubPrototypeBlocks(s, opts), s);
  }
});

test("decisions: REVISE / SCRAP / SHORTLIST, null when absent", () => {
  assert.deepEqual(parseDecisionFor("blah\n**Decision on P2:** SHORTLIST — show it", "P2"), { decision: "SHORTLIST", reason: "show it" });
  assert.equal(parseDecisionFor("- Decision on P2 — scrap: not worth it", "P2").decision, "SCRAP");
  assert.equal(parseDecisionFor("Decision on P2 (v1): Revised – bigger button", "P2", 1).decision, "REVISE");
  assert.equal(parseDecisionFor("Decision on P2: maybe", "P2"), null);
  assert.equal(parseDecisionFor("nothing here", "P2"), null);
});
