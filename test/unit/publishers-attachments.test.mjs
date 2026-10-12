import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubFetch } from "./helpers.mjs";
import { createPublicChannel } from "../../dist/publishers/index.js";
import { headerValue } from "../../dist/publishers/ntfy.js";
import { formatTitle } from "../../dist/publishers/transcript.js";

const ok = () => new Response("{}", { status: 200 });
const ntfyCfg = { kind: "ntfy", ntfyUrl: "https://ntfy.example.test", topicPrefix: "rt" };
const webhookCfg = { kind: "webhook", webhookUrl: "https://hooks.example.test/in", topicPrefix: "rt" };
const tmp = () => mkdtemp(join(tmpdir(), "rt-att-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);
const ndjson = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** Decode RFC 2047 encoded words the way ntfy (Go's mime.WordDecoder) does. */
function decode2047(v) {
  return v.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=\s*/gi, (_m, b) => Buffer.from(b, "base64").toString("utf8")).trim();
}

const shot = (over = {}) => ({
  turn: 3,
  speaker: "alice",
  filename: "P1v1-desktop.png",
  contentType: "image/png",
  bytes: PNG,
  caption: "P1 v1 screenshot (desktop)",
  ...over,
});

test("ntfy attachment: PUT to the topic with the bytes as body and Filename/Title/Message headers, in order", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["alice", "bob"] }, {
    config: { ...ntfyCfg, ntfyToken: "tk_secret" },
    transcriptsDir: await tmp(),
    postHeader: false,
  });
  ch.record({ turn: 3, speaker: "alice", content: "my proposal" });
  ch.recordAttachment(shot());
  await ch.finalize();
  const sends = calls.filter((c) => c.init.method === "POST" || c.init.method === "PUT");
  assert.deepEqual(sends.map((c) => c.init.method), ["POST", "PUT"], "attachment queued after the turn");
  const put = sends[1];
  assert.equal(put.url, `https://ntfy.example.test/${ch.topic}`);
  assert.equal(put.body, undefined, "binary body is not JSON");
  assert.ok(put.init.body instanceof Uint8Array);
  assert.deepEqual(Buffer.from(put.init.body), PNG);
  const h = put.init.headers;
  assert.equal(h.Filename, "P1v1-desktop.png");
  assert.equal(h.Firebase, "no");
  assert.equal(h.Authorization, "Bearer tk_secret");
  assert.equal(h.Message, "P1 v1 screenshot (desktop)");
  for (const v of Object.values(h)) assert.match(v, /^[\x20-\x7e]*$/, "header values are ASCII");
  // The title keeps the formatTitle shape once decoded (it carries a non-ASCII separator).
  assert.equal(decode2047(h.Title), formatTitle(3, "alice #2"));
  assert.ok(put.signal);
});

test("ntfy attachment: caption is redacted, filename sanitized, non-ASCII caption RFC 2047-encoded", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.recordAttachment(shot({ caption: "Screenshot for jane@corp.example — ünïcode ✓", filename: "../../évil name.png" }));
  await ch.finalize();
  const put = calls.find((c) => c.init.method === "PUT");
  assert.match(put.init.headers.Filename, /^[A-Za-z0-9._-]+$/);
  assert.ok(!put.init.headers.Filename.includes(".."));
  const caption = decode2047(put.init.headers.Message);
  assert.ok(!caption.includes("jane@corp.example"));
  assert.match(caption, /\[redacted:email\] — ünïcode ✓/);
  assert.equal(headerValue("plain ascii"), "plain ascii");
  const long = "é".repeat(200);
  const enc = headerValue(long);
  assert.ok(enc.split(" ").every((w) => w.length <= 75), "encoded words stay short");
  assert.equal(decode2047(enc), long);
  assert.equal(headerValue("line one\r\nline two"), "line one line two");
});

test("ntfy attachment: 413 is a clear, non-retryable failure; daily quota stops the channel", async (t) => {
  let puts = 0;
  stubFetch(t, (url, init) => {
    if (init.method === "PUT") {
      puts++;
      return new Response(JSON.stringify({ code: 41301, http: 413, error: "attachment too large" }), { status: 413 });
    }
    return url.includes("/json?") ? new Response("", { status: 200 }) : ok();
  });
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: async () => {} });
  ch.record({ turn: 1, speaker: "a", content: "text" });
  ch.recordAttachment(shot({ turn: 1, speaker: "a" }));
  ch.record({ turn: 2, speaker: "a", content: "after" });
  const res = await ch.finalize();
  assert.equal(puts, 1, "not retried");
  assert.equal(res.total, 3);
  assert.equal(res.published, 2, "later entries still go out");
  assert.equal(res.degraded, false);

  t.mock.restoreAll();
  const calls = stubFetch(t, (url, init) =>
    init.method === "PUT"
      ? new Response(JSON.stringify({ code: 42908, error: "daily quota reached" }), { status: 429 })
      : url.includes("/json?") ? new Response("", { status: 200 }) : ok()
  );
  const ch2 = createPublicChannel("s2", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false, sleep: async () => {} });
  ch2.recordAttachment(shot({ turn: 1, speaker: "a" }));
  ch2.record({ turn: 2, speaker: "a", content: "after" });
  const res2 = await ch2.finalize();
  assert.equal(res2.degraded, true);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 0);
});

test("webhook attachment: JSON metadata only, never the bytes", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: webhookCfg, transcriptsDir: await tmp(), postHeader: false });
  ch.recordAttachment(shot({ turn: 1, speaker: "a" }));
  await ch.finalize();
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.init.method, "POST");
  assert.equal(typeof c.init.body, "string");
  assert.equal(c.body.kind, "attachment");
  assert.equal(c.body.content, "P1 v1 screenshot (desktop)");
  assert.deepEqual(c.body.attachment, { filename: "P1v1-desktop.png", contentType: "image/png", size: PNG.length });
  assert.ok(!c.init.body.includes(PNG.toString("base64")));
  assert.ok(!("bytes" in c.body.attachment));
});

test("recordAttachment: appears in the finalized transcript and matches the public history", async (t) => {
  const dir = await tmp();
  let topic = "";
  stubFetch(t, (url, init) => {
    if (url.includes("/json?")) {
      // ntfy returns the decoded Title and the Message header text as `message`.
      return new Response(
        ndjson([
          { id: "1", time: 1, event: "message", topic, title: "#01 · a", message: "turn text" },
          { id: "2", time: 2, event: "message", topic, title: "#01 · a #2", message: "P1 v1 screenshot (desktop)", attachment: { name: "P1v1-desktop.png" } },
        ]),
        { status: 200 }
      );
    }
    return ok();
  });
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: dir, postHeader: false });
  topic = ch.topic;
  ch.record({ turn: 1, speaker: "a", content: "turn text" });
  ch.recordAttachment(shot({ turn: 1, speaker: "a" }));
  const res = await ch.finalize();
  assert.equal(res.total, 2);
  assert.equal(res.published, 2);
  assert.ok(!res.warnings.some((w) => /matched no entry|differs/.test(w)), res.warnings.join("; "));
  const md = await readFile(res.savedPath, "utf8");
  assert.match(md, /## #01 · a #2 \(attachment\)\n\nP1 v1 screenshot \(desktop\)/);
  assert.ok(!md.includes("public copy differs"));
});

test("recordAttachment: never throws, ignored after finalize", async (t) => {
  const calls = stubFetch(t, ok);
  const ch = createPublicChannel("s1", { participants: ["a"] }, { config: ntfyCfg, transcriptsDir: await tmp(), postHeader: false });
  assert.doesNotThrow(() => ch.recordAttachment({ turn: 1, speaker: null, filename: null, contentType: "", bytes: null, caption: null }));
  const p = ch.finalize();
  ch.recordAttachment(shot());
  const res = await p;
  assert.equal(res.total, 1);
  assert.equal(calls.filter((c) => c.init.method === "PUT").length, 1);
});
