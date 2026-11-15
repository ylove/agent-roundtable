import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readRegularFile, RegularFileError } = await import("../../dist/security/fs-safe.js");

test("readRegularFile reads a regular file and reports its stat", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-fsread-"));
  try {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello", { mode: 0o600 });
    const { data, stat } = readRegularFile(file, { maxBytes: 5, noFollow: true });
    assert.equal(data.toString(), "hello");
    assert.equal(stat.size, 5);
    assert.throws(() => readRegularFile(file, { maxBytes: 4 }), (e) => e instanceof RegularFileError && e.code === "EFBIG");
    assert.throws(() => readRegularFile(file, { accept: () => { throw new Error("refused"); } }), /refused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readRegularFile refuses directories and, when asked, symlinks; a missing file keeps ENOENT", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-fsread-"));
  try {
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    symlinkSync(file, join(dir, "link"));
    mkdirSync(join(dir, "sub"));
    assert.throws(() => readRegularFile(join(dir, "sub")), (e) => e instanceof RegularFileError && e.code === "ENOTREG");
    assert.throws(() => readRegularFile(join(dir, "link"), { noFollow: true }), (e) => e instanceof RegularFileError && e.code === "ENOTREG");
    assert.equal(readRegularFile(join(dir, "link")).data.toString(), "x");
    assert.throws(() => readRegularFile(join(dir, "none")), (e) => e.code === "ENOENT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
