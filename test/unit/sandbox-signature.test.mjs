import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { failureSignature, normalizeOutput, signatureLines, SIGNATURE_LINES } = await import("../../dist/sandbox/signature.js");

function nodeTestFailure({ stamp, tmp, ms, pid, expected = "2", actual = "3", color = false }) {
  const red = color ? "\x1b[31m" : "";
  const reset = color ? "\x1b[0m" : "";
  return [
    `[${stamp}] starting test run (pid ${pid})`,
    `${red}✖ adds numbers (${ms})${reset}`,
    `  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`,
    ``,
    `  ${actual} !== ${expected}`,
    ``,
    `      at TestContext.<anonymous> (${tmp}/work/test/math.test.mjs:12:10)`,
    `      at Test.runInAsyncScope (node:async_hooks:211:14)`,
    `  actual: ${actual}`,
    `  expected: ${expected}`,
    `  duration_ms: ${parseFloat(ms)}`,
    `listening on 127.0.0.1:${40000 + pid % 1000}`,
    `object at 0x${(pid * 7919).toString(16).padStart(12, "0")}`,
    `# tests 3`,
    `# fail 1`,
  ].join("\n");
}

test("the same failure with different timestamps, paths, durations, pids, ports and colors has one signature", () => {
  const a = nodeTestFailure({ stamp: "2026-10-15T09:12:33.120Z", tmp: "/tmp/rt-sbx-a1b2c3", ms: "12.5ms", pid: 4242 });
  const b = nodeTestFailure({ stamp: "2026-10-16T21:01:02+02:00", tmp: "/private/var/folders/zz/abc123/T/rt-sbx-q9", ms: "1.204ms", pid: 777, color: true });
  const c = nodeTestFailure({ stamp: "2026-11-01 08:00:00", tmp: join(tmpdir(), "rt-sbx-other"), ms: "3s", pid: 31337 });
  const sa = failureSignature("unit", a);
  assert.match(sa, /^[0-9a-f]{64}$/);
  assert.equal(failureSignature("unit", b), sa);
  assert.equal(failureSignature("unit", c), sa);
});

test("a different assertion, or a different command id, changes the signature", () => {
  const base = { stamp: "2026-10-15T09:12:33Z", tmp: "/tmp/x", ms: "5ms", pid: 1 };
  const same = failureSignature("unit", nodeTestFailure(base));
  assert.notEqual(failureSignature("unit", nodeTestFailure({ ...base, expected: "4" })), same);
  assert.notEqual(failureSignature("lint", nodeTestFailure(base)), same);
});

test("normalizeOutput strips ANSI, unifies line endings and replaces volatile tokens", () => {
  const out = normalizeOutput(
    "\x1b[1;31mError\x1b[0m at 12:34:56.789 took 1.5s\r\nprogress 10%\rprogress 100%\n" +
      "\x1b]8;;http://x\x07link\x1b]8;;\x07 id 123e4567-e89b-12d3-a456-426614174000  \n" +
      "/var/tmp/cache-77/file.js:3:1 and /home/me/tmp/keep.txt port=8080 PID: 99"
  );
  assert.equal(
    out,
    "Error at <time> took <dur>\nprogress 10%\nprogress 100%\n" +
      "link id <uuid>\n" +
      "<tmp> and /home/me/tmp/keep.txt port=<n> PID: <n>"
  );
});

test("line numbers and file names outside temp dirs are kept", () => {
  const a = "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
  const b = "src/a.ts(11,5): error TS2322: Type 'string' is not assignable to type 'number'.";
  assert.notEqual(failureSignature("tsc", a), failureSignature("tsc", b));
  assert.equal(normalizeOutput(a), a);
});

test("only the first 60 error-like lines count, falling back to the last 60 lines", () => {
  const errors = Array.from({ length: 80 }, (_, i) => `error ${i}`);
  const lines = signatureLines(errors.join("\n"));
  assert.equal(lines.length, SIGNATURE_LINES);
  assert.equal(lines[0], "error 0");
  assert.equal(lines.at(-1), "error 59");
  // Changes after the 60th error line do not move the signature.
  const tweaked = [...errors.slice(0, 70), "error changed", ...errors.slice(71)];
  assert.equal(failureSignature("c", tweaked.join("\n")), failureSignature("c", errors.join("\n")));

  const plain = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const tail = signatureLines(plain.join("\n"));
  assert.equal(tail.length, SIGNATURE_LINES);
  assert.equal(tail[0], "line 40");
  assert.equal(tail.at(-1), "line 99");
});

test("error-like matching covers TAP, panics and exceptions", () => {
  const out = "ok 1 - fine\nnot ok 2 - broken\nthread 'main' panicked\nUnhandled exception\nall good";
  assert.deepEqual(signatureLines(out), ["not ok 2 - broken", "thread 'main' panicked", "Unhandled exception"]);
});
