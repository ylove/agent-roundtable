import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { redactSecrets } from "../../dist/security/redaction-rules.js";
import { redactPII } from "../../dist/publishers/redact.js";
import { stripThinkTags } from "../../dist/providers/shared.js";
import { parsePrototypeBlock, scrubPrototypeBlocks, replacePrototypeBlock } from "../../dist/prototypes/parse.js";
import { extractJsonObject } from "../../dist/sessions/workshop.js";

function quickly(fn) {
  const start = performance.now();
  fn();
  assert.ok(performance.now() - start < 1000, "text processing stays within 1s");
}

test("redaction bounds processing time for long identifiers and local parts", () => {
  for (const input of ["_".repeat(200_000), "a".repeat(200_000), "token_".repeat(30_000)]) {
    quickly(() => assert.equal(redactSecrets(input).text, input));
    quickly(() => assert.equal(redactPII(input).text, input));
  }
  assert.equal(redactSecrets('cfg: client_secret_value="two words"').text, 'cfg: client_secret_value="[redacted:secret]"');
  assert.equal(redactPII("mail a+b@example.test").text, "mail [redacted:email]");
});

test("redaction covers alphabet-only and short authorization tokens", () => {
  for (const scheme of ["Basic", "Bearer"]) {
    for (const token of ["YWJjOmRlZmdo", "abc", "a1+/"]) {
      const out = redactSecrets(`Authorization: ${scheme} ${token}`).text;
      assert.ok(!out.includes(token));
      assert.match(out, /\[redacted:/);
    }
  }
  assert.equal(redactSecrets("sk-" + "z".repeat(32)).text, "[redacted:api_key]");
  assert.equal(redactSecrets("sk-learn and task-oriented words").text, "sk-learn and task-oriented words");
});

test("reasoning tags are scanned once, including unmatched openings", () => {
  const input = "<think>".repeat(30_000);
  quickly(() => assert.equal(stripThinkTags(input), input));
  assert.equal(stripThinkTags("before<think>a<think>b</think> \nanswer<think>unfinished"), "beforeanswer<think>unfinished");
});

test("prototype parsing bounds repeated unclosed file tags", () => {
  const input = '<prototype kind="code">' + '<file path="a.txt">'.repeat(30_000) + "</prototype>";
  quickly(() => {
    const result = parsePrototypeBlock(input);
    assert.equal(result.ok, false);
    assert.match(result.error, /not closed/);
  });
  quickly(() => assert.match(parsePrototypeBlock('<prototype>' + '<file '.repeat(30_000) + '</prototype>').error, /not closed/));
  const mentions = "<prototype> ".repeat(30_000);
  quickly(() => assert.equal(scrubPrototypeBlocks(mentions, { first: "[first]", extra: "[extra]", unclosed: "[cut]" }), mentions));
  const oversized = "a".repeat(1024 * 1024 + 1);
  assert.match(parsePrototypeBlock(oversized).error, /size limit/);
  assert.equal(scrubPrototypeBlocks(oversized, { first: null, extra: "[extra]", unclosed: "[cut]" }), "[cut]");
  assert.equal(replacePrototypeBlock(oversized, "[cut]"), "[cut]");
});

test("JSON extraction bounds repeated openings and retains completed inner objects", () => {
  const input = "{".repeat(30_000);
  quickly(() => assert.throws(() => extractJsonObject(input), /Invalid JSON/));
  quickly(() => assert.deepEqual(extractJsonObject(input + '"ok":true}'), { ok: true }));
  assert.throws(() => extractJsonObject("a".repeat(1024 * 1024 + 1)), /size limit/);
});

test("webhook header examples include the header name", () => {
  for (const file of ["../../.env.example", "../../docs/configuration.md"]) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), /Authorization: Bearer abc123/);
  }
});
