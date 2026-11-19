import { test } from "node:test";
import assert from "node:assert/strict";

const { humanTime, formatDate, relativeTime } = await import("../../dist/dashboard/time.js");
const { siteHeader, sitePage, SITE_NAV } = await import("../../dist/dashboard/shell.js");

test("times are local and readable, keep the exact ISO value, and tolerate bad input", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(relativeTime("2026-11-15T12:00:00Z", now), "3 days ago");
  assert.equal(relativeTime("2026-11-18T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-11-18T12:05:00Z", now), "in 5 minutes");
  assert.equal(formatDate("not a date"), "");
  assert.equal(relativeTime(undefined, now), "");
  const html = humanTime("2026-11-15T12:00:00Z", now);
  assert.match(html, /^<time datetime="2026-11-15T12:00:00.000Z" title="2026-11-15T12:00:00.000Z">/);
  assert.ok(html.includes(formatDate("2026-11-15T12:00:00Z")));
  assert.doesNotMatch(html, /T12:00:00\.000Z<\/time>/, "the visible text is not the raw ISO string");
  assert.match(humanTime("garbage"), /unknown/);
});

test("the site header links home from the mark, lists every section and marks the active one", () => {
  const html = siteHeader("/tok/", "duels");
  assert.match(html, /<a class="brand" href="\/tok\/">/);
  for (const [, label, path] of SITE_NAV) assert.ok(html.includes(`href="/tok/${path}"`) && html.includes(`>${label}<`), label);
  assert.match(html, /href="\/tok\/duels" class="here" aria-current="page">Duels</);
  assert.equal((html.match(/aria-current/g) ?? []).length, 1);
  assert.doesNotMatch(siteHeader('/"x/'), /href="\/"x/, "the base is escaped");
});

test("site pages carry the shared assets, extra assets, and the escaped title", () => {
  const html = sitePage({ base: "/tok/", title: "A <b>", body: "<p>hi</p>", stylesheets: ["static/duel.css"], scripts: ["static/duel.js"] });
  assert.match(html, /<title>A &lt;b&gt; · Roundtable<\/title>/);
  assert.ok(html.indexOf("static/dashboard.css") < html.indexOf("static/duel.css"));
  assert.ok(html.indexOf("static/dashboard.js") < html.indexOf("static/duel.js"));
  assert.ok(html.indexOf('class="site-header"') < html.indexOf("<main><p>hi</p></main>"));
  assert.doesNotMatch(html, /<script>|style=/, "no inline script or style under the page CSP");
});
