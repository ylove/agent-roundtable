import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { absoluteSearchPath, findExecutable } from "../../dist/executables.js";

test("executable lookup returns a canonical file from absolute PATH directories", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "rt-executable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, "bin"));
  fs.mkdirSync(join(root, "other"));
  const file = join(root, "bin", "tool");
  fs.writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write("ready");\n`, { mode: 0o755 });
  fs.symlinkSync("bin", join(root, "alias"));
  const cwd = process.cwd();
  let found;
  try {
    process.chdir(root);
    assert.equal(findExecutable("tool", ["", ".", "bin", "alias"].join(delimiter)), null);
    found = findExecutable("tool", ["", "missing", "alias", join(root, "alias")].join(delimiter));
  } finally {
    process.chdir(cwd);
  }
  assert.ok(isAbsolute(found));
  assert.equal(found, fs.realpathSync.native(file));
  assert.equal(execFileSync(found, { cwd: join(root, "other"), encoding: "utf8" }), "ready");
});

test("executable lookup skips unresolved and non-executable candidates", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "rt-executable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, "directory"));
  fs.writeFileSync(join(root, "plain"), "text", { mode: 0o600 });
  fs.symlinkSync("absent", join(root, "dangling"));
  fs.symlinkSync("cycle", join(root, "cycle"));
  for (const name of ["directory", "plain", "dangling", "cycle", "../plain"]) {
    assert.equal(findExecutable(name, root), null, name);
  }
});

test("child PATH keeps only absolute directories after profile extras", async () => {
  const { childEnv } = await import("../../dist/security/child-env.js");
  const absolute = process.platform === "win32" ? "C:\\tools" : "/usr/bin";
  const mixed = ["", ".", "bin", "./node_modules/.bin", absolute, ""].join(delimiter);
  assert.equal(absoluteSearchPath(mixed), absolute);
  for (const profile of ["git", "runner", "runtime", "sandbox-local"]) {
    assert.equal(childEnv(profile, {}, { PATH: mixed }).PATH, absolute);
    assert.equal(childEnv(profile, { PATH: mixed }, { PATH: "relative" }).PATH, absolute);
    assert.equal(childEnv(profile, {}, {}).PATH, undefined);
  }
});
