import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubFetch, json } from "./helpers.mjs";
import {
  createPublicChannel,
  createPublisher,
  publicLabel,
  publicSessionDirective,
  NtfyPublisher,
  WebhookPublisher,
} from "../../dist/publishers/index.js";
import { chunkText } from "../../dist/publishers/queue.js";
import { redact } from "../../dist/publishers/redact.js";
import { parseTitle, reassemble, mergeTranscript, formatTitle } from "../../dist/publishers/transcript.js";
import { buildChannelId } from "../../dist/publishers/shared.js";

const ok = () => new Response("{}", { status: 200 });
const fastSleep = (sleeps) => async (ms) => void sleeps.push(ms);
const ntfyCfg = { kind: "ntfy", ntfyUrl: "https://ntfy.example.test", topicPrefix: "rt" };
const tmp = () => mkdtemp(join(tmpdir(), "rt-pub-"));
const ndjson = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const msgEv = (title, message, time = 1) => ({ id: title, time, event: "message", topic: "t", title, message });

// ---- chunking ----
test("chunkText: small text is one chunk", () => {
  assert.deepEqual(chunkText("hello"), ["hello"]);
});

test("chunkText: <=3800 bytes, UTF-8 safe, exact reassembly", () => {
  const text = ("héllo wörld 日本語 🎉🎉 ".repeat(40) + "\n\n").repeat(30);
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, "utf8") <= 3800);
    assert.ok(!c.includes("\uFFFD"));
    assert.equal(Buffer.from(c, "utf8").toString("utf8"), c);
  }
  assert.equal(chunks.join(""), text);
});

test("chunkText: prefers paragraph boundaries, and handles unbroken text", () => {
  const para = "a".repeat(2000);
  const chunks = chunkText(`${para}\n\n${para}\n\n${para}`);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].endsWith("\n\n") && chunks[1].endsWith("\n\n"));
  assert.equal(chunks[2], para);
  const solid = "🎉".repeat(3000); // 12000 bytes, no boundaries
  const c2 = chunkText(solid);
  assert.equal(c2.join(""), solid);
  for (const c of c2) assert.ok(Buffer.byteLength(c) <= 3800);
});

// ---- topic ----
test("buildChannelId: format, regex, length, random part never truncated", () => {
  const rnd = "abcdefghijklmnopqrstuv";
  const c = buildChannelId("roundtable", "sess-1", rnd);
  assert.equal(c.id, `roundtable-sess-1-${rnd}`);
  const long = buildChannelId("p".repeat(80), "s".repeat(80) + "!! weird/id", rnd);
  assert.ok(long.id.length <= 64);
  assert.match(long.id, /^[-_A-Za-z0-9]{1,64}$/);
  assert.ok(long.id.endsWith(rnd));
  const real = buildChannelId("roundtable", "collab 12");
  assert.match(real.id, /^[-_A-Za-z0-9]{1,64}$/);
  assert.notEqual(real.id, buildChannelId("roundtable", "collab 12").id);
});

test("titles: format and parse round-trip", () => {
  assert.equal(formatTitle(7, "skeptic"), "#07 · skeptic");
  assert.equal(formatTitle(7, "skeptic", 2, 3), "#07 · skeptic (2/3)");
  assert.deepEqual(parseTitle("#07 · skeptic (2/3)"), { turn: 7, speaker: "skeptic", part: 2, parts: 3 });
  assert.deepEqual(parseTitle("#123 · a b"), { turn: 123, speaker: "a b", part: 1, parts: 1 });
  assert.equal(parseTitle("random"), null);
});

// ---- ntfy wire format ----
test("ntfy: JSON body, Firebase: no, bearer auth", async (t) => {
  const calls = stubFetch(t, ok);
  const dir = await tmp();
  const ch = createPublicChannel("s1", { mode: "debate", participants: ["a", "b"], topic: "T" }, {
    config: { ...ntfyCfg, ntfyToken: "tk_secret" },
    transcriptsDir: dir,
    postHeader: false,
  });
  ch.record({ turn: 1, speaker: "a", content: "hi there" });
  await ch.finalize();
  const post = calls.find((c) => c.init.method === "POST");
  assert.equal(post.url, "https://ntfy.example.test/");
  assert.equal(post.init.headers["Firebase"], "no");
  assert.equal(post.init.headers["Content-Type"], "application/json");
  assert.equal(post.init.headers["Authorization"], "Bearer tk_secret");
  assert.equal(post.body.topic, ch.topic);
  assert.equal(post.body.title, "#01 · a");
  assert.equal(post.body.message, "hi there");
  assert.equal(post.body.markdown, true);
  assert.ok(post.signal);
  assert.equal(ch.url, `https://ntfy.example.test/${ch.topic}`);
});

test("ntfy: basic auth applied to publish and history fetch", async (t) => {
  const calls = stubFetch(t, (url) => (url.includes("/json?") ? new Response("", { status: 200 }) : ok()));
  const ch = createPublicChannel("s1", { participants: ["a"] }, {
    config: { ...ntfyCfg, ntfyUser: "u", ntfyPassword: "p" },
    transcriptsDir: await tmp(),
    postHeader: false,
  });
  ch.record({ turn: 1, speaker: "a", content: "x" });
  await ch.finalize();
  const expected = "Basic " + Buffer.from("u:p").toString("base64");
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.equal(c.init.headers["Authorization"], expected);
});

test("multi-chunk entries post titled parts in order", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.record({ turn: 3, speaker: "a", content: ("word ".repeat(300) + "\n\n").repeat(6) });
  await ch.finalize();
  const posts = calls.filter((c) => c.init.method === "POST");
  assert.ok(posts.length >= 2);
  posts.forEach((p, i) => {
    assert.equal(p.body.title, `#03 · a (${i + 1}/${posts.length})`);
    assert.ok(Buffer.byteLength(p.body.message) <= 3800);
  });
});

// ---- rate limits ----
test("429 with Retry-After: waits, then succeeds", async (t) => {
  const sleeps = [];
  let n = 0;
  const calls = stubFetch(t, (url) => {
    if (url.includes("/json?")) return new Response("", { status: 200 });
    return n++ === 0
      ? new Response(JSON.stringify({ code: 42901, error: "limit reached" }), { status: 429, headers: { "Retry-After": "7" } })
      : ok();
  });
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep(sleeps) });
  ch.record({ turn: 1, speaker: "a", content: "x" });
  const res = await ch.finalize();
  assert.deepEqual(sleeps, [7000]);
  assert.equal(res.published, 1);
  assert.equal(res.failed, 0);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 2);
});

test("429 without Retry-After: exponential backoff from 5s", async (t) => {
  const sleeps = [];
  let n = 0;
  stubFetch(t, (url) => {
    if (url.includes("/json?")) return new Response("", { status: 200 });
    return n++ < 3 ? new Response("rate", { status: 429 }) : ok();
  });
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep(sleeps) });
  ch.record({ turn: 1, speaker: "a", content: "x" });
  const res = await ch.finalize();
  assert.deepEqual(sleeps, [5000, 10000, 20000]);
  assert.equal(res.published, 1);
});

test("daily limit (code 42908): degrades and stops further posts", async (t) => {
  const calls = stubFetch(t, (url) =>
    url.includes("/json?")
      ? new Response("", { status: 200 })
      : new Response(JSON.stringify({ code: 42908, http: 429, error: "limit reached: daily message quota reached" }), { status: 429 })
  );
  const dir = await tmp();
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: dir, sleep: fastSleep([]) });
  for (let i = 1; i <= 4; i++) ch.record({ turn: i, speaker: "a", content: `msg ${i}` });
  const res = await ch.finalize();
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
  assert.equal(res.degraded, true);
  assert.equal(res.published, 0);
  assert.equal(res.total, 5);
  assert.equal(res.failed, 5);
  assert.ok(res.warnings.some((w) => /degraded/i.test(w)));
  const md = await readFile(res.savedPath, "utf8");
  assert.equal(md.split("_[not delivered to public channel]_").length - 1, 5);
  assert.ok(md.includes("msg 4"));
});

test("429 whose error text mentions quota also degrades", async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ error: "Daily limit reached" }), { status: 429 }));
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep([]) });
  ch.record({ turn: 1, speaker: "a", content: "1" });
  ch.record({ turn: 2, speaker: "a", content: "2" });
  const res = await ch.finalize();
  assert.equal(calls.length, 1);
  assert.equal(res.degraded, true);
});

test("network error is recorded, never thrown", async (t) => {
  stubFetch(t, () => {
    throw new TypeError("fetch failed");
  });
  const dir = await tmp();
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: dir, postHeader: false, sleep: fastSleep([]), maxAttempts: 2 });
  assert.doesNotThrow(() => ch.record({ turn: 1, speaker: "a", content: "still saved locally" }));
  const res = await ch.finalize();
  assert.equal(res.published, 0);
  assert.equal(res.failed, 1);
  assert.ok(res.warnings.length > 0);
  assert.ok((await readFile(res.savedPath, "utf8")).includes("still saved locally"));
});

test("flush timeout is bounded", async (t) => {
  t.mock.method(globalThis, "fetch", () => new Promise(() => {})); // never resolves
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, flushTimeoutMs: 30 });
  ch.record({ turn: 1, speaker: "a", content: "x" });
  const res = await ch.finalize();
  assert.equal(res.published, 0);
  assert.ok(res.warnings.some((w) => /did not finish/.test(w)));
});

// ---- history ----
test("history: only message events, truncation flag, order, dedup, parts", async (t) => {
  const calls = stubFetch(t, (url, init) => {
    if (url.includes("/json?")) {
      return new Response(
        ndjson([
          { id: "o", time: 1, event: "open", topic: "t" },
          msgEv("#02 · b (2/2)", " world"),
          msgEv("#01 · a", "first"),
          { id: "k", time: 2, event: "keepalive", topic: "t" },
          msgEv("#02 · b (1/2)", "hello"),
          msgEv("#02 · b (1/2)", "hello"), // duplicate
          msgEv("unparseable", "ignored"),
        ]),
        { status: 200, headers: { "X-Messages-Truncated": "1" } }
      );
    }
    return ok();
  });
  const dir = await tmp();
  const ch = createPublicChannel("s1", { mode: "standard", participants: ["a", "b"], topic: "Subj" }, { config: ntfyCfg, transcriptsDir: dir, postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "first" });
  ch.record({ turn: 2, speaker: "b", content: "hello world" });
  const res = await ch.finalize();
  const hist = calls.find((c) => c.url.includes("/json?"));
  assert.match(hist.url, /\/json\?poll=1&since=all$/);
  assert.ok(res.warnings.some((w) => /truncated/.test(w)));
  const md = await readFile(res.savedPath, "utf8");
  assert.match(md, /^---\nsession: "s1"/);
  assert.ok(md.indexOf("first") < md.indexOf("hello world"));
  assert.equal((md.match(/hello world/g) || []).length, 1);
  assert.ok(!md.includes("ignored"));
  assert.ok(!md.includes("not delivered"));
});

test("reassemble: sort by (turn, part), dedup, incomplete flagged", () => {
  const out = reassemble([
    { title: "#05 · x (3/3)", content: "C" },
    { title: "#05 · x (1/3)", content: "A" },
    { title: "#05 · x (1/3)", content: "A-dup" },
    { title: "#05 · x (2/3)", content: "B" },
    { title: "#04 · y (1/2)", content: "only" },
  ]);
  assert.equal(out[0].turn, 4);
  assert.equal(out[0].complete, false);
  assert.equal(out[1].content, "ABC");
  assert.equal(out[1].complete, true);
});

test("merge: undelivered local entries included and marked", async (t) => {
  stubFetch(t, (url, init) => {
    if (url.includes("/json?")) return new Response(ndjson([msgEv("#01 · a", "one")]), { status: 200 });
    const body = JSON.parse(init.body);
    return body.title === "#02 · b" ? new Response("bad", { status: 400 }) : ok();
  });
  const dir = await tmp();
  const ch = createPublicChannel("s1", { participants: ["a", "b"] }, { config: ntfyCfg, transcriptsDir: dir, postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "one" });
  ch.record({ turn: 2, speaker: "b", content: "two" });
  const res = await ch.finalize();
  assert.equal(res.published, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.degraded, false);
  const md = await readFile(res.savedPath, "utf8");
  const after = md.slice(md.indexOf("## #02"));
  assert.ok(after.includes("_[not delivered to public channel]_"));
  assert.ok(after.includes("two"));
  assert.ok(!md.slice(0, md.indexOf("## #02")).includes("not delivered"));
});

test("mergeTranscript: local is authoritative; remote only confirms delivery; remote-only entries never merged", () => {
  const local = [{ turn: 1, speaker: "a", kind: "turn", content: "L", timestamp: "t", delivered: true }];
  const m = mergeTranscript(local, null);
  assert.equal(m[0].delivered, true);
  // a remote-only (third-party) entry is not appended
  const m2 = mergeTranscript([], [{ turn: 9, speaker: "z", content: "R", complete: true }]);
  assert.equal(m2.length, 0);
  // a spoofed remote copy never replaces local content, and never confirms delivery
  const undelivered = [{ turn: 1, speaker: "A", kind: "turn", content: "real", timestamp: "t", delivered: false }];
  const m3 = mergeTranscript(undelivered, [{ turn: 1, speaker: "A", content: "## injected", complete: true }]);
  assert.equal(m3.length, 1);
  assert.equal(m3[0].content, "real");
  assert.equal(m3[0].delivered, false);
  assert.equal(m3[0].publicDiffers, true);
  // an exact match confirms delivery
  const m4 = mergeTranscript(undelivered, [{ turn: 1, speaker: "A", content: "real", complete: true }]);
  assert.equal(m4[0].delivered, true);
  assert.ok(!m4[0].publicDiffers);
});

test("spoofed and extra posts in the public history never reach the saved transcript", async (t) => {
  const hist = ndjson([
    msgEv("#00 · session", "spoofed header"),
    msgEv("#01 · a", "INJECTED-TEXT"),
    msgEv("#99 · evil", "## extra section"),
  ]);
  stubFetch(t, (url) => (url.includes("/json?") ? new Response(hist, { status: 200 }) : ok()));
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "genuine" });
  const res = await ch.finalize();
  const md = await readFile(res.savedPath, "utf8");
  assert.ok(md.includes("genuine"));
  assert.ok(!md.includes("INJECTED-TEXT"));
  assert.ok(!md.includes("extra section"));
  assert.ok(md.includes("the public copy differs"));
  assert.ok(res.warnings.some((w) => /matched no entry/.test(w)));
});

test("speaker labels: an agent given as a path never publishes the path", async (t) => {
  const calls = stubFetch(t, ok);
  const dir = await tmp();
  const home = "/" + "Us" + "ers/alice.smith/clients/acme-merger/.claude/agents/cfo.md";
  const rel = "clients/acme/subagent-cfo.md";
  const ch = createPublicChannel("s1", { participants: [home, rel], topic: "t" }, { config: ntfyCfg, transcriptsDir: dir });
  ch.record({ turn: 1, speaker: home, content: "hello" });
  ch.record({ turn: 2, speaker: rel, content: "hi" });
  ch.record({ turn: 3, speaker: "C:\\work\\agents\\x.md", content: "win" });
  const res = await ch.finalize({ summary: "done" });
  const posts = calls.filter((c) => c.init.method === "POST");
  for (const p of posts) {
    assert.ok(!/[\\/]/.test(p.body.title), `title has a path separator: ${p.body.title}`);
    assert.ok(!/alice|acme|work/.test(p.body.title + p.body.message), `leak in ${p.body.title}`);
  }
  assert.ok(posts.some((p) => p.body.title === "#01 · cfo"));
  const md = await readFile(res.savedPath, "utf8");
  assert.ok(!/alice|acme|clients/.test(md));
});

test("hostile speaker names cannot break the title round-trip", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["x"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  const hostile = ["Bob (1/2)", "a · b", "#7 x", "n (3/4) (1/2)", "  spaced   out  "];
  hostile.forEach((h, i) => ch.record({ turn: i + 1, speaker: h, content: "c" }));
  await ch.finalize();
  const titles = calls.filter((c) => c.init.method === "POST").map((c) => c.body.title);
  assert.equal(titles.length, hostile.length);
  titles.forEach((title, i) => {
    const p = parseTitle(title);
    assert.ok(p, title);
    assert.equal(p.turn, i + 1);
    assert.equal(p.part, 1);
    assert.equal(p.parts, 1);
    assert.equal(formatTitle(p.turn, p.speaker), title);
  });
});

test("saved transcript front matter and heading use the redacted topic and participants", async (t) => {
  stubFetch(t, ok);
  const home = "/" + "Us" + "ers/alice.smith/x/cfo.md";
  const ch = createPublicChannel(
    "s1",
    { participants: [home, "b"], topic: "Call jane@corp.example or 415-555-2671 re deal" },
    { config: ntfyCfg, transcriptsDir: await tmp() }
  );
  ch.record({ turn: 1, speaker: "b", content: "x" });
  const res = await ch.finalize();
  const md = await readFile(res.savedPath, "utf8");
  assert.ok(!md.includes("jane@corp.example"));
  assert.ok(!md.includes("415-555-2671"));
  assert.ok(!md.includes("alice"));
  assert.match(md, /participants: \["cfo", "b"\]/);
  assert.match(md, /\[redacted:email\]/);
});

test("record() after finalize started is ignored; finalize twice returns the same result", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "one" });
  const p = ch.finalize();
  ch.record({ turn: 2, speaker: "a", content: "late" });
  const r1 = await p;
  assert.equal(await ch.finalize(), r1);
  assert.equal(r1.total, 1);
  assert.ok(!calls.some((c) => c.body?.message === "late"));
});

test("unwritable transcripts dir: savedPath null, warning, no throw", async (t) => {
  stubFetch(t, ok);
  const dir = await tmp();
  const blocker = join(dir, "file");
  await (await import("node:fs/promises")).writeFile(blocker, "x");
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: join(blocker, "sub"), postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "one" });
  const res = await ch.finalize();
  assert.equal(res.savedPath, null);
  assert.ok(res.warnings.some((w) => /Could not save the transcript/.test(w)));
});

test("Retry-After: HTTP-date is honored and a huge value is capped at maxWait", async (t) => {
  const sleeps = [];
  let n = 0;
  stubFetch(t, (url) => {
    if (url.includes("/json?")) return new Response("", { status: 200 });
    n++;
    if (n === 1) return new Response("{}", { status: 429, headers: { "Retry-After": new Date(Date.now() + 3000).toUTCString() } });
    if (n === 2) return new Response("{}", { status: 429, headers: { "Retry-After": "99999" } });
    return ok();
  });
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep(sleeps) });
  ch.record({ turn: 1, speaker: "a", content: "x" });
  const res = await ch.finalize();
  assert.equal(res.published, 1);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 4000, `date wait ${sleeps[0]}`);
  assert.equal(sleeps[1], 60000);
});

test("flush timeout aborts the queue: later entries are not sent", async (t) => {
  t.mock.method(globalThis, "fetch", () => new Promise(() => {}));
  const dir = await tmp();
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: dir, postHeader: false, flushTimeoutMs: 20 });
  ch.record({ turn: 1, speaker: "a", content: "one" });
  ch.record({ turn: 2, speaker: "a", content: "two" });
  const res = await ch.finalize();
  assert.equal(res.published, 0);
  assert.equal(res.failed, 2);
  assert.ok((await readFile(res.savedPath, "utf8")).includes("two"));
});

test("401/403 stops the channel (auth); a 400 on one entry does not stop later entries", async (t) => {
  const calls = stubFetch(t, () => new Response("{}", { status: 401 }));
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep([]) });
  for (let i = 1; i <= 3; i++) ch.record({ turn: i, speaker: "a", content: `m${i}` });
  const res = await ch.finalize();
  assert.equal(res.degraded, true);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);

  let n = 0;
  const calls2 = stubFetch(t, (url) => (url.includes("/json?") ? new Response("", { status: 200 }) : new Response("{}", { status: n++ === 0 ? 400 : 200 })));
  const ch2 = createPublicChannel("s2", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep([]) });
  for (let i = 1; i <= 3; i++) ch2.record({ turn: i, speaker: "a", content: `m${i}` });
  const res2 = await ch2.finalize();
  assert.equal(res2.degraded, false);
  assert.equal(res2.published, 2);
  assert.equal(res2.failed, 1);
  assert.equal(calls2.filter((c) => c.init.method === "POST").length, 3);
});

test("3 consecutive entries exhausting retries degrades the channel", async (t) => {
  const calls = stubFetch(t, () => new Response("{}", { status: 503 }));
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: fastSleep([]), maxAttempts: 2 });
  for (let i = 1; i <= 5; i++) ch.record({ turn: i, speaker: "a", content: `m${i}` });
  const res = await ch.finalize();
  assert.equal(res.degraded, true);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 6); // 3 entries x 2 attempts, then stop
});

test("history tolerates keepalive/open/delete events, a partial last line and non-JSON lines", async (t) => {
  const body =
    [
      JSON.stringify({ id: "1", time: 1, event: "open", topic: "t" }),
      JSON.stringify({ id: "2", time: 2, event: "keepalive", topic: "t" }),
      "not json at all",
      JSON.stringify(msgEv("#01 · a", "hello")),
      JSON.stringify({ id: "3", time: 3, event: "message_delete", topic: "t" }),
      '{"id":"4","time":4,"event":"mess',
    ].join("\n");
  stubFetch(t, (url) => (url.includes("/json?") ? new Response(body, { status: 200 }) : ok()));
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "hello" });
  const res = await ch.finalize();
  assert.equal(res.published, 1);
  assert.equal(res.warnings.filter((w) => /matched no entry/.test(w)).length, 0);
});

test("transcript file: name, front matter, temp dir", async (t) => {
  stubFetch(t, (url) => (url.includes("/json?") ? new Response("", { status: 200 }) : ok()));
  const dir = join(await tmp(), "nested", "dir");
  const ch = createPublicChannel("sess9", { mode: "debate", participants: ["a", "b"], topic: "Is X true?" }, { config: ntfyCfg, transcriptsDir: dir });
  ch.record({ turn: 1, speaker: "a", content: "claim" });
  const res = await ch.finalize({ summary: "wrap up" });
  assert.ok(res.savedPath.startsWith(dir));
  assert.match(res.savedPath, /\d{4}-\d{2}-\d{2}-sess9-[-_A-Za-z0-9]{8}\.md$/);
  const md = await readFile(res.savedPath, "utf8");
  assert.match(md, /participants: \["a", "b"\]/);
  assert.match(md, /mode: "debate"/);
  assert.ok(md.includes(`url: "${ch.url}"`));
  assert.ok(md.includes("wrap up"));
  assert.ok(md.includes("Is X true?"));
  assert.equal(res.total, 3); // header + turn + summary
  assert.equal(res.published, 3);
  // finalize is idempotent
  assert.equal(await ch.finalize(), res);
});

test("duplicate (turn, speaker) labels are disambiguated", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.record({ turn: 2, speaker: "caller", content: "1", kind: "caller" });
  ch.record({ turn: 2, speaker: "caller", content: "2", kind: "caller" });
  await ch.finalize();
  const titles = calls.filter((c) => c.init.method === "POST").map((c) => c.body.title);
  assert.deepEqual(titles, ["#02 · caller", "#02 · caller #2"]);
});

// ---- webhook ----
test("webhook: body, auth header, view url, no history fetch", async (t) => {
  const calls = stubFetch(t, ok);
  const dir = await tmp();
  const ch = createPublicChannel("s1", { participants: ["a"] }, {
    config: {
      kind: "webhook",
      ntfyUrl: "https://unused.test",
      topicPrefix: "rt",
      webhookUrl: "https://hook.example.test/in",
      webhookViewUrl: "https://view.example.test/c/{channel}",
      webhookAuthHeader: "X-Api-Key: abc:123",
    },
    transcriptsDir: dir,
    postHeader: false,
  });
  ch.record({ turn: 4, speaker: "skeptic", kind: "nudge", content: "hello" });
  const res = await ch.finalize();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hook.example.test/in");
  assert.equal(calls[0].init.headers["X-Api-Key"], "abc:123");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["channel", "content", "kind", "part", "parts", "session", "speaker", "timestamp", "turn"]);
  assert.equal(calls[0].body.session, "s1");
  assert.equal(calls[0].body.channel, ch.topic);
  assert.equal(calls[0].body.kind, "nudge");
  assert.equal(calls[0].body.part, 1);
  assert.equal(calls[0].body.parts, 1);
  assert.equal(ch.url, `https://view.example.test/c/${ch.topic}`);
  assert.equal(res.published, 1);
  assert.ok((await readFile(res.savedPath, "utf8")).includes("hello"));
});

test("publisher factory: clear errors", () => {
  assert.throws(() => createPublisher({ ...ntfyCfg, kind: "carrier-pigeon" }), /Unknown ROUNDTABLE_PUBLISHER "carrier-pigeon"/);
  assert.throws(() => createPublisher({ ...ntfyCfg, kind: "webhook" }), /ROUNDTABLE_WEBHOOK_URL/);
  assert.throws(() => createPublisher({ ...ntfyCfg, ntfyUrl: "nope" }), /NTFY_URL/);
  assert.throws(() => createPublicChannel("s", { participants: [] }, { config: { ...ntfyCfg, kind: "x" } }), /Unknown/);
  assert.ok(createPublisher(ntfyCfg) instanceof NtfyPublisher);
  assert.ok(createPublisher({ ...ntfyCfg, kind: "webhook", webhookUrl: "https://h.test/x" }) instanceof WebhookPublisher);
});

// ---- redaction ----
const homePath = "/" + "Us" + "ers/alice/projects/secret.txt";
const winPath = "C:\\" + "Us" + "ers\\bob\\Documents\\x.txt";

test("redact: positives", () => {
  const cases = [
    ["mail me at jane.doe+x@example.co.uk now", "email", "[redacted:email]"],
    ["call (415) 555-2671 today", "phone", "[redacted:phone]"],
    ["call 415-555-2671 today", "phone", "[redacted:phone]"],
    ["call +44 20 7946 0958 today", "phone", "[redacted:phone]"],
    ["key sk-ant-api03-abcdefgh12345678", "api_key", "[redacted:api_key]"],
    ["key sk-proj-abcdefghij1234567890KLMN", "api_key", "[redacted:api_key]"],
    ["token tk_abcdefghijklmnopqrstuvwxyz123", "api_key", "[redacted:api_key]"],
    ["ghp_" + "a".repeat(36), "api_key", "[redacted:api_key]"],
    ["gho_" + "b".repeat(36), "api_key", "[redacted:api_key]"],
    ["github_pat_" + "c".repeat(40), "api_key", "[redacted:api_key]"],
    ["AKIAIOSFODNN7EXAMPLE", "api_key", "[redacted:api_key]"],
    ["xoxb-1234567890-abcdefghij", "api_key", "[redacted:api_key]"],
    ["r8_" + "d".repeat(30), "api_key", "[redacted:api_key]"],
    ["Authorization: Bearer abc123def456ghi789", "bearer", "Bearer [redacted:bearer]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt", "[redacted:jwt]"],
    ["api_key=supersecretvalue", "secret", "api_key=[redacted:secret]"],
    ['password: "hunter22"', "secret", 'password: "[redacted:secret]"'],
    ["look in " + homePath + " please", "path", "look in [redacted:path] please"],
    ["see /home/carol/.ssh/id_rsa", "path", "see [redacted:path]"],
    ["file " + winPath, "path", "file [redacted:path]"],
    ["host 10.0.0.5 and 192.168.1.20 and 172.20.3.4", "ip", "host [redacted:ip] and [redacted:ip] and [redacted:ip]"],
    ["card 4111 1111 1111 1111 ok", "card", "card [redacted:card] ok"],
    ["card 4111111111111111", "card", "card [redacted:card]"],
    ["ssn 123-45-6789 ok", "ssn", "ssn [redacted:ssn] ok"],
  ];
  for (const [input, kind, expected] of cases) {
    const r = redact(input);
    assert.ok(r.counts[kind] >= 1, `${kind} not counted for: ${input} -> ${r.text}`);
    if (expected.startsWith("[") || expected.includes(" ") || expected.includes("=")) {
      assert.ok(r.text.includes(expected.replace(/^.*?(\[redacted)/, "$1")) || r.text === expected, `unexpected: ${r.text}`);
    }
  }
  assert.equal(redact("host 10.0.0.5 and 192.168.1.20").text, "host [redacted:ip] and [redacted:ip]");
  assert.equal(redact("see /home/carol/.ssh/id_rsa").text, "see [redacted:path]");
  assert.equal(redact("api_key=supersecretvalue").text, "api_key=[redacted:secret]");
  assert.equal(redact("mail a@b.com").counts.email, 1);
});

test("redact: negatives leave ordinary text alone", () => {
  const safe = [
    "In 2026 we shipped version 0.2.0 of the tool.",
    "Turn #07 was the best one; see #12 too.",
    "The date 2026-09-29 and range 2020-2026.",
    "Public IP 8.8.8.8 and 172.32.0.1 and 11.0.0.1 are not private.",
    "A 13-digit timestamp 1758000000000 and number 4111111111112 (bad luhn).",
    "Bearer authentication is a scheme; the password field is required.",
    "Order 12345 costs 1,234,567 dollars; call it 100-200.",
    "Visit https://example.com/home/feed or docs at example.com/guide",
    "The sk-learn library and ssh-keygen are fine.",
    "SSN-like 000-12-3456 and 900-12-3456 are invalid.",
    "Node 24.1.0, Express 5.2.1, React 19.2.3.",
  ];
  for (const s of safe) {
    const r = redact(s);
    assert.equal(r.text, s, `mangled: ${s} -> ${r.text}`);
    assert.deepEqual(r.counts, {});
  }
});

test("redaction runs on outgoing messages and the local copy", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.record({ turn: 1, speaker: "a", content: "write to bob@example.com about " + homePath });
  const res = await ch.finalize();
  const sent = calls.find((c) => c.init.method === "POST").body.message;
  assert.equal(sent, "write to [redacted:email] about [redacted:path]");
  assert.deepEqual(res.redactions, { email: 1, path: 1 });
  const md = await readFile(res.savedPath, "utf8");
  assert.ok(!md.includes("bob@example.com"));
});

// ---- directive ----
test("public-session directive covers the required rules", () => {
  const d = publicSessionDirective();
  assert.match(d, /world-readable/);
  assert.match(d, /public URLs/);
  assert.match(d, /credentials/);
  assert.match(d, /personal information/);
  assert.match(d, /no audience/i);
});

test("redact: prefixed env keys, PEM, vendor tokens, basic auth, URL credentials, unformatted phone/SSN", () => {
  const key = "AIza" + "a".repeat(35);
  const pem = '{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0B\\nabcdef\\n-----END PRIVATE KEY-----\\n","client_email":"x@y.iam.example.com"}';
  const cases = [
    ["DB_PASSWORD=hunter2222", "hunter2222"],
    ["OPENAI_API_KEY=abcd1234efgh", "abcd1234efgh"],
    ["STRIPE_SECRET_KEY: " + "sk_live_" + "a1B2c3D4e5F6", "a1B2c3D4e5F6"],
    [pem, "MIIEvQIBADANBgkqhkiG9w0B"],
    ["k " + key, key],
    ["rk_live_" + "Z9y8X7w6V5u4", "Z9y8X7w6V5u4"],
    ["npm_" + "a1".repeat(18), "a1a1a1"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["postgres://admin:s3cr3tpass@10.0.0.5:5432/app", "s3cr3tpass"],
    ["phone: 2065551234", "2065551234"],
    ["ssn 123456789", "123456789"],
    ["SSN: 123 45 6789", "123 45 6789"],
  ];
  for (const [input, secret] of cases) {
    const r = redact(input);
    assert.ok(!r.text.includes(secret), `leaked ${secret} in: ${r.text}`);
  }
  // plain prose and version-like numbers survive
  assert.equal(redact("Bring 2065551234 widgets").text, "Bring 2065551234 widgets");
});

// ---- follow-up fixes: redaction gaps, labels, whitespace-normalized merge ----
test("redact: secret keyword in the middle of a key name", () => {
  const cases = [
    "AWS_SECRET_ACCESS_KEY=abcdEFGH1234ijkl",
    "aws_secret_access_key = abc123def456",
    "SECRET_ACCESS_KEY: xyzzy1",
    "GITHUB_TOKEN_READONLY=ghs-value-12345",
    "client_secret_value=abcd1234",
    '{"db_password":"a,b;c d"}',
    'password="two words here"',
    "api_key='x y z'",
  ];
  for (const c of cases) {
    const out = redact("cfg: " + c + " end").text;
    assert.match(out, /\[redacted:secret\]/, c);
    for (const leak of ["abcdEFGH1234ijkl", "abc123def456", "xyzzy1", "ghs-value", "abcd1234", "a,b;c d", "two words", "x y z", "words here"]) {
      assert.ok(!out.includes(leak), `${c} -> ${out}`);
    }
  }
  assert.equal(redact('password="two words here" tail').text, 'password="[redacted:secret]" tail');
  assert.equal(redact('{"db_password":"a,b;c d"}').text, '{"db_password":"[redacted:secret]"}');
});

test("redact: ordinary prose with secret-ish words is untouched", () => {
  for (const t of [
    "the token budget is 250 messages",
    "password managers are good",
    "an author wrote: hello there",
    "the secret to good bread is patience",
  ]) {
    assert.equal(redact(t).text, t);
  }
});

test("redact: empty-user URL credentials and letters-only bearer tokens", () => {
  const r = redact("redis://:pass@host:6379 and postgres://u:pw@db/x").text;
  assert.ok(!r.includes(":pass@") && !r.includes("u:pw@"), r);
  assert.match(r, /redis:\/\/\[redacted:url_credentials\]@host/);
  const b = redact("Authorization: Bearer abcdefghijklmnopqrstuv").text;
  assert.ok(!b.includes("abcdefghijklmnopqrstuv"), b);
  assert.equal(redact("Bearer tokens are fine").text, "Bearer tokens are fine");
});

test("publicLabel: part suffix is not treated as a path; real paths still reduce to a base name", () => {
  assert.equal(publicLabel("Bob (1/2)"), "Bob");
  assert.equal(publicLabel("Bob (1/2) (2/3)"), "Bob");
  assert.equal(publicLabel("/" + "Us" + "ers/x/agents/subagent-alice.md"), "alice");
  assert.equal(publicLabel("./rel/dir/carol.md"), "carol");
  assert.equal(publicLabel("../up/dave"), "dave");
  assert.equal(publicLabel("C:\\dir\\erin.md"), "erin");
  assert.equal(publicLabel("dir/frank"), "frank");
  assert.ok(!publicLabel("Ann (x/y) says").includes("/"));
});

test("mergeTranscript: whitespace-trimmed chunks still confirm delivery of multi-part entries", () => {
  const content = "first part\n\nsecond part\n\nthird part";
  const local = [{ turn: 1, speaker: "A", kind: "turn", content, timestamp: "t", delivered: false }];
  const remote = [{ turn: 1, speaker: "A", content: "first part\nsecond part \n\nthird part", complete: true }];
  const m = mergeTranscript(local, remote);
  assert.equal(m[0].delivered, true);
  assert.equal(m[0].publicDiffers, undefined);
  const diff = mergeTranscript(local, [{ turn: 1, speaker: "A", content: "other", complete: true }]);
  assert.equal(diff[0].publicDiffers, true);
});
