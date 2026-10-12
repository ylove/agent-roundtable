import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrototypeRoot,
  createSessionDir,
  materializeFiles,
  removeDir,
  removeDirSync,
  sweepStaleSessionDirs,
} from "../../dist/prototypes/sandbox.js";

const tmp = () => mkdtemp(join(tmpdir(), "rt-proto-sb-"));

test("ensurePrototypeRoot: creates the root with a .gitignore of *", async () => {
  const base = await tmp();
  const root = await ensurePrototypeRoot(join(base, "nested", "protos"));
  assert.ok(existsSync(root));
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "*\n");
  if (process.platform !== "win32") assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("ensurePrototypeRoot: refuses a root inside a git work tree", async () => {
  const repo = await tmp();
  await mkdir(join(repo, ".git"));
  await assert.rejects(() => ensurePrototypeRoot(join(repo, "a", "b")), /git work tree/);
  assert.equal(existsSync(join(repo, "a")), false, "nothing is created inside the repository");
  // A .git file (worktrees, submodules) counts too.
  const wt = await tmp();
  await writeFile(join(wt, ".git"), "gitdir: elsewhere\n");
  await assert.rejects(() => ensurePrototypeRoot(join(wt, "protos")), /git work tree/);
});

test("ensurePrototypeRoot: the default root comes from ROUNDTABLE_PROTOTYPE_DIR (test env temp dir)", async () => {
  const root = await ensurePrototypeRoot();
  assert.ok(root.endsWith("prototypes"));
  assert.ok(!root.includes(process.cwd()), "never under the repository");
});

test("createSessionDir: mkdtemp per session with owner.json", async () => {
  const root = await ensurePrototypeRoot(join(await tmp(), "r"));
  const a = await createSessionDir(root, "collab-1");
  const b = await createSessionDir(root, "collab-1");
  assert.notEqual(a, b);
  assert.match(a, /collab-1-[^/\\]+$/);
  const owner = JSON.parse(await readFile(join(a, "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.createdAt);
  const weird = await createSessionDir(root, "../../evil id");
  assert.ok(weird.startsWith(root));
});

test("materializeFiles: writes nested files with safe modes; redacts when asked", async () => {
  const dir = await tmp();
  const secret = "sk-ant-" + "abcdefghijklmnop1234";
  const files = [
    { path: "index.html", content: "<p>hi</p>" },
    { path: "js/app.js", content: `const key = "${secret}";` },
  ];
  const plain = await materializeFiles(join(dir), files, { redactContent: false });
  assert.equal(await readFile(join(dir, "js", "app.js"), "utf8"), files[1].content);
  assert.equal(plain[1].content, files[1].content);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(dir, "index.html"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "js"))).mode & 0o777, 0o700);
  }
  const dir2 = await tmp();
  const red = await materializeFiles(dir2, files, { redactContent: true });
  const onDisk = await readFile(join(dir2, "js", "app.js"), "utf8");
  assert.ok(!onDisk.includes(secret));
  assert.match(onDisk, /\[redacted:/);
  assert.equal(red[1].content, onDisk);
});

test("materializeFiles: refuses traversal, absolute paths, symlinks and overwrites", async () => {
  const dir = await tmp();
  for (const bad of ["../x.txt", "/abs.txt", "a/../../b.txt", "a\\b.txt"]) {
    await assert.rejects(() => materializeFiles(dir, [{ path: bad, content: "x" }], { redactContent: false }), /path/i, bad);
  }
  const outside = await tmp();
  await symlink(outside, join(dir, "link"));
  await assert.rejects(() => materializeFiles(dir, [{ path: "link/x.txt", content: "x" }], { redactContent: false }));
  assert.equal(existsSync(join(outside, "x.txt")), false);
  await writeFile(join(dir, "exists.txt"), "old");
  await assert.rejects(() => materializeFiles(dir, [{ path: "exists.txt", content: "new" }], { redactContent: false }));
  assert.equal(await readFile(join(dir, "exists.txt"), "utf8"), "old");
});

test("materializeFiles: never recreates a removed directory", async () => {
  const base = await tmp();
  const gone = join(base, "gone");
  await assert.rejects(() => materializeFiles(gone, [{ path: "a/b.txt", content: "x" }], { redactContent: false }));
  assert.equal(existsSync(gone), false);
});

test("removeDir / removeDirSync: rm -rf, refuse roots, never throw", async () => {
  const d = await tmp();
  await mkdir(join(d, "x", "y"), { recursive: true });
  assert.equal(await removeDir(d), true);
  assert.equal(existsSync(d), false);
  assert.equal(await removeDir(d), true, "removing a missing dir is fine");
  assert.equal(await removeDir("/"), false);
  assert.equal(await removeDir("relative/path"), false);
  const d2 = await tmp();
  assert.equal(removeDirSync(d2), true);
  assert.equal(existsSync(d2), false);
  assert.equal(removeDirSync("/"), false);
});

function deadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid));
  });
}

test("sweepStaleSessionDirs: removes dirs of dead pids, keeps live ones and unowned dirs", async () => {
  const root = await ensurePrototypeRoot(join(await tmp(), "r"));
  const mine = await createSessionDir(root, "mine");
  const dead = join(root, "dead-abc");
  await mkdir(dead);
  await writeFile(join(dead, "owner.json"), JSON.stringify({ pid: await deadPid(), createdAt: "x" }));
  const parent = join(root, "parent-abc");
  await mkdir(parent);
  await writeFile(join(parent, "owner.json"), JSON.stringify({ pid: process.ppid, createdAt: "x" }));
  const unowned = join(root, "unowned");
  await mkdir(unowned);
  const garbage = join(root, "garbage");
  await mkdir(garbage);
  await writeFile(join(garbage, "owner.json"), "{not json");

  const n = await sweepStaleSessionDirs(root);
  assert.equal(n, 1);
  assert.equal(existsSync(dead), false);
  assert.ok(existsSync(mine));
  assert.ok(existsSync(parent));
  assert.ok(existsSync(unowned));
  assert.ok(existsSync(garbage));
  assert.equal(await sweepStaleSessionDirs(join(root, "does-not-exist")), 0);
});
