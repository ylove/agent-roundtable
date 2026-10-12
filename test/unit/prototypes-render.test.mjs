import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  mermaidLiveUrl,
  renderPublicPrototype,
  renderStub,
  renderOutcomesMarkdown,
  fence,
  PUBLIC_SOURCE_CAP_BYTES,
} from "../../dist/prototypes/render.js";
import { buildPrototypeDirective, publicPrototypeAmendment } from "../../dist/prototypes/directive.js";

const rec = (over = {}) => ({
  id: "P1", version: 1, label: "P1 v1", key: "P1v1", title: "Inline coupon field", kind: "web", proposer: "alice",
  files: [{ path: "index.html", content: "<!doctype html><p>hi</p>" }, { path: "app.js", content: "go()" }],
  fileCount: 2, entry: "index.html", demo: "Impatient user: taps twice.", status: "live", verdicts: [], ...over,
});

function decodeMermaidLive(url) {
  const m = /^https:\/\/mermaid\.live\/view#pako:([A-Za-z0-9_-]+)$/.exec(url);
  assert.ok(m, `unexpected link: ${url}`);
  return JSON.parse(inflateSync(Buffer.from(m[1], "base64url")).toString("utf8"));
}

test("mermaidLiveUrl: pako link round-trips to the original code (live-editor state shape)", () => {
  const code = 'flowchart TD\n  A["Coupon ✓ ünïcode"] -->|apply| B{valid?}\n  B -- yes --> C[Discount]';
  const url = mermaidLiveUrl(code);
  assert.ok(!url.includes("="), "no base64 padding");
  const state = decodeMermaidLive(url);
  assert.equal(state.code, code);
  assert.equal(typeof state.mermaid, "string");
  assert.deepEqual(JSON.parse(state.mermaid), { theme: "default" });
  assert.equal(state.updateDiagram, true);
});

test("renderPublicPrototype: heading, meta, demo, fenced source with languages", () => {
  const md = renderPublicPrototype(rec());
  assert.match(md, /^\*\*Prototype P1 v1 — Inline coupon field\*\*/);
  assert.match(md, /_web · 2 files · proposed by alice_/);
  assert.match(md, /Impatient user: taps twice\./);
  assert.match(md, /`index.html`\n\n```html\n<!doctype html><p>hi<\/p>\n```/);
  assert.match(md, /```javascript\ngo\(\)\n```/);
});

test("renderPublicPrototype: ~8 KB cap with a truncation note; fences survive backticks", () => {
  const big = "x".repeat(6000);
  const md = renderPublicPrototype(rec({ files: [{ path: "a.js", content: big }, { path: "b.js", content: big }, { path: "c.js", content: "```nested```" }], fileCount: 3 }));
  const shown = (md.match(/x/g) || []).length;
  assert.ok(shown <= PUBLIC_SOURCE_CAP_BYTES + 100, `${shown} bytes shown`);
  assert.match(md, /…\[truncated: \d+ more bytes\]/);
  const total = 12000 + "```nested```".length;
  const n = Number(/truncated: (\d+) more bytes/.exec(md)[1]);
  assert.equal(n, total - PUBLIC_SOURCE_CAP_BYTES);
  assert.equal(fence("a ``` b", "md"), "````md\na ``` b\n````");
});

test("renderPublicPrototype: diagrams get a mermaid.live link; text gets the draft", () => {
  const d = renderPublicPrototype(rec({ kind: "diagram", files: [{ path: "flow.mmd", content: "flowchart TD\nA-->B" }], fileCount: 1 }));
  const link = /View diagram: (\S+)/.exec(d)[1];
  assert.equal(decodeMermaidLive(link).code, "flowchart TD\nA-->B");
  assert.match(d, /```mermaid\nflowchart TD/);
  const t = renderPublicPrototype(rec({ kind: "text", files: [{ path: "draft.md", content: "# Dear customer" }], fileCount: 1 }));
  assert.match(t, /\*\*Draft 1\*\*/);
  assert.match(t, /# Dear customer/);
});

test("renderPublicPrototype: never contains 127.0.0.1, localhost or a board URL", () => {
  const hostile = rec({
    title: "See http://127.0.0.1:5555/p/P1v1/",
    demo: "Open http://localhost:5555/ then ws://localhost:9/x and [::1]",
    files: [{ path: "index.html", content: `<a href="http://127.0.0.1:8080/">x</a> fetch('http://localhost/api') // 127.0.0.1 localhost` }],
  });
  const md = renderPublicPrototype(hostile);
  assert.ok(!/127\.0\.0\.1|localhost/i.test(md), md);
  const diagram = renderPublicPrototype(rec({ kind: "diagram", files: [{ path: "f.mmd", content: "flowchart TD\nA[localhost]-->B" }], fileCount: 1 }));
  assert.ok(!/127\.0\.0\.1|localhost/i.test(diagram));
  assert.ok(!/localhost/.test(decodeMermaidLive(/View diagram: (\S+)/.exec(diagram)[1]).code));
});

test("renderStub: one line per status", () => {
  const v = [{ assessor: "cfo", verdict: "REVISE", reason: "x" }, { assessor: "skeptic", verdict: "APPROVE", reason: "" }];
  assert.equal(
    renderStub(rec({ status: "shortlisted", verdicts: v, decision: { decision: "SHORTLIST", reason: "y" }, files: [], fileCount: 3 })),
    '[Prototype P1 v1 "Inline coupon field" (web, 3 files) — destroyed after assessment; verdicts: cfo REVISE, skeptic APPROVE; decision: SHORTLIST]'
  );
  assert.match(renderStub(rec({ status: "revised", verdicts: v, supersededBy: "P1 v2" })), /decision: REVISE \(superseded by P1 v2\)\]$/);
  assert.match(renderStub(rec({ status: "scrapped", verdicts: v })), /decision: SCRAP\]$/);
  assert.match(renderStub(rec({ status: "expired" })), /time limit ran out; verdicts so far: none\]$/);
  assert.match(renderStub(rec({ status: "closed", fileCount: 1 })), /\(web, 1 file\) — destroyed when the session ended/);
  assert.match(renderStub(rec({ title: 'say "hi"' })), /"say 'hi'"/);
});

test("renderOutcomesMarkdown: outcomes, shortlist with full source, closing line", () => {
  const short = rec({ status: "shortlisted", decision: { decision: "SHORTLIST", reason: "clear win" }, verdicts: [{ assessor: "cfo", verdict: "APPROVE", reason: "good" }] });
  const scrapped = rec({ id: "P2", label: "P2 v1", key: "P2v1", status: "scrapped", files: [], fileCount: 1, kind: "code", title: "Schema" });
  const md = renderOutcomesMarkdown([short, scrapped], [short]);
  assert.match(md, /^## Prototype outcomes\n\n- \*\*P1 v1\*\* · alice · web · "Inline coupon field" · verdicts: cfo APPROVE \(good\) · decision: SHORTLIST \(clear win\) · status: shortlisted/);
  assert.match(md, /- \*\*P2 v1\*\* · alice · code · "Schema" · verdicts: none · decision: none · status: scrapped/);
  assert.match(md, /## Shortlist for the human\n\n### P1 v1 — Inline coupon field/);
  assert.match(md, /```html\n<!doctype html><p>hi<\/p>\n```/);
  assert.match(md, /\nThe session is complete: the human may now give feedback on these proposals\.$/);
  const none = renderOutcomesMarkdown([], []);
  assert.match(none, /No prototypes were proposed/);
  assert.match(none, /None of the prototypes were shortlisted\./);
});

test("directive: format, kinds, demo rule, verdict and decision lines; meeting phrasing", () => {
  const d = buildPrototypeDirective({ assessorIsCaller: false, public: false });
  assert.ok(d.startsWith("\n\n## Prototype mode\n"));
  for (const s of [
    "Show, don't just tell",
    '<prototype title="Short title" kind="web|code|diagram|text" entry="index.html">',
    '<file path="index.html">',
    "<demo>",
    "never executed",
    "Mermaid",
    "draft 1",
    "<demo> is REQUIRED",
    "at least three user types or modalities",
    "Verdict on Pn: APPROVE|REVISE|REJECT — reason",
    "Decision on Pn: REVISE|SCRAP|SHORTLIST — reason",
    '<prototype revises="Pn">',
    "SHORTLIST means it is chosen to show the human",
    "destroyed",
    "credentials",
  ]) {
    assert.ok(d.includes(s), `missing: ${s}`);
  }
  const m = buildPrototypeDirective({ assessorIsCaller: true, public: false });
  assert.ok(m.includes("the person you're meeting with assesses your prototype"));
  assert.match(publicPrototypeAmendment(), /written fresh|write fresh/);
  assert.match(publicPrototypeAmendment(), /never reproduce existing or private source code/i);
});
