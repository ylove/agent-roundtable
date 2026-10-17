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
      "/var/tmp/cache-77/file.js:3:1 and /home/me/tmp/keep.txt port=8080 port 54321 PID: 99 at 1760500000123"
  );
  assert.equal(
    out,
    "Error at <time> took <dur>\nprogress 10%\nprogress 100%\n" +
      "link id <uuid>\n" +
      "<tmp> and /home/me/tmp/keep.txt port=8080 port <n> PID: <n> at <epoch>"
  );
});

test("line numbers and file names outside temp dirs are kept", () => {
  const a = "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
  const b = "src/a.ts(11,5): error TS2322: Type 'string' is not assignable to type 'number'.";
  assert.notEqual(failureSignature("tsc", a), failureSignature("tsc", b));
  assert.equal(normalizeOutput(a), a);
});

test("long selections keep their first 30 and last 30 lines; no markers falls back to the last 60", () => {
  const errors = Array.from({ length: 80 }, (_, i) => `error ${i}`);
  const lines = signatureLines(errors.join("\n"));
  assert.equal(lines.length, SIGNATURE_LINES);
  assert.deepEqual([lines[0], lines[29], lines[30], lines.at(-1)], ["error 0", "error 29", "error 50", "error 79"]);
  // The middle does not move the signature; the end does.
  const middle = errors.map((l, i) => (i === 40 ? "error changed" : l));
  assert.equal(failureSignature("c", middle.join("\n")), failureSignature("c", errors.join("\n")));
  const end = errors.map((l, i) => (i === 75 ? "error changed" : l));
  assert.notEqual(failureSignature("c", end.join("\n")), failureSignature("c", errors.join("\n")));

  const plain = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const tail = signatureLines(plain.join("\n"));
  assert.equal(tail.length, SIGNATURE_LINES);
  assert.equal(tail[0], "line 40");
  assert.equal(tail.at(-1), "line 99");
});

/** A long passing node --test log whose test names contain "error" and "fail", then one failure. */
function longLogThenFailure(detail) {
  const passing = [];
  for (let i = 0; i < 700; i++) {
    passing.push(`# Subtest: handles error case ${i}`, `ok ${i + 1} - handles error case ${i}`, `✔ reports failures clearly ${i} (${i % 7}.5ms)`);
  }
  return [
    ...passing,
    "✖ late test (3ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "",
    `  ${detail} !== 2`,
    "",
    "# tests 701",
    "# pass 700",
    "# fail 1",
  ].join("\n");
}

test("two different failures late in a long passing log have different signatures", () => {
  const a = longLogThenFailure("3");
  const b = longLogThenFailure("4");
  assert.notEqual(failureSignature("unit", a), failureSignature("unit", b));
  // Passing lines never count, even when their names say "error" or "fail".
  const lines = signatureLines(a);
  assert.ok(lines.every((l) => !/^(ok |✔|# Subtest:|# pass)/.test(l)), lines.join("\n"));
  assert.ok(lines.includes("✖ late test (<dur>)"));
  assert.ok(lines.includes("  3 !== 2"), "the lines after a strong marker carry the detail");
});

test("chosen ports are kept and ephemeral ones normalized", () => {
  assert.notEqual(failureSignature("e2e", "Error: connect ECONNREFUSED 127.0.0.1:80"), failureSignature("e2e", "Error: connect ECONNREFUSED 127.0.0.1:443"));
  assert.notEqual(failureSignature("e2e", "Error: listen EADDRINUSE on port 80"), failureSignature("e2e", "Error: listen EADDRINUSE on port 443"));
  assert.equal(failureSignature("e2e", "Error: socket hang up 127.0.0.1:51234"), failureSignature("e2e", "Error: socket hang up 127.0.0.1:60001"));
  assert.equal(failureSignature("e2e", "Error: worker pid 4242 died"), failureSignature("e2e", "Error: worker pid 77 died"));
  assert.equal(failureSignature("e2e", "Error: stale at 1760500000123"), failureSignature("e2e", "Error: stale at 1760599999999"));
});

test("error-like matching covers TAP, panics and exceptions", () => {
  const out = "ok 1 - fine\nnot ok 2 - broken\nthread 'main' panicked\nUnhandled exception\nall good";
  // Strong markers (not ok, panic) and the lines after them; the passing "ok 1" never counts.
  assert.deepEqual(signatureLines(out), ["not ok 2 - broken", "thread 'main' panicked", "Unhandled exception", "all good"]);
  // Without strong markers, weaker error-like lines are used.
  assert.deepEqual(signatureLines("starting\n3 tests failed to load\ndone"), ["3 tests failed to load"]);
});
