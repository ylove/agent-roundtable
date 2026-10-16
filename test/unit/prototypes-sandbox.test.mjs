import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrototypeRoot,
  createSessionDir,
  materializeFiles,
  releaseSessionDir,
  removeDir,
  removeDirSync,
  sweepStaleSessionDirs,
} from "../../dist/prototypes/sandbox.js";

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "rt-proto-sb-"));
  made.push(d);
  return d;
};
const posix = process.platform !== "win32";

test("ensurePrototypeRoot: creates the root with a .gitignore of *", async () => {
  const base = await tmp();
  const root = await ensurePrototypeRoot(join(base, "nested", "protos"));
  assert.ok(existsSync(root));
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "*\n");
  if (posix) assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("ensurePrototypeRoot: forces an existing root to 0700; refuses a symlink, a file and another user's directory", { skip: !posix }, async () => {
  const base = await tmp();
  const open = join(base, "open");
  await mkdir(open, { mode: 0o755 });
  await chmod(open, 0o755);
  await ensurePrototypeRoot(open);
  assert.equal((await stat(open)).mode & 0o777, 0o700);

  const target = join(base, "target");
  await mkdir(target);
  await symlink(target, join(base, "link"));
  await assert.rejects(() => ensurePrototypeRoot(join(base, "link")), /symbolic link/);
  assert.equal(existsSync(join(target, ".gitignore")), false, "nothing written through the link");

  await writeFile(join(base, "file"), "x");
  await assert.rejects(() => ensurePrototypeRoot(join(base, "file")), /not a directory/);

  if (process.getuid?.() !== 0) {
    // A system directory owned by root: refused before anything is changed.
    await assert.rejects(() => ensurePrototypeRoot("/usr/bin"), /owned by another user/);
  }
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

test("createSessionDir: mkdtemp (0700) per session with owner.json (pid, host, createdAt)", async () => {
  const root = await ensurePrototypeRoot(join(await tmp(), "r"));
  const a = await createSessionDir(root, "collab-1");
  const b = await createSessionDir(root, "collab-1");
  assert.notEqual(a, b);
  assert.match(a, /collab-1-[^/\\]+$/);
  if (posix) assert.equal((await stat(a)).mode & 0o777, 0o700);
  const owner = JSON.parse(await readFile(join(a, "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, hostname());
  assert.ok(!Number.isNaN(Date.parse(owner.createdAt)));
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

const HOUR = 60 * 60 * 1000;

/** A session-shaped directory (mkdtemp-style name) with an optional owner.json and a P1v1 directory. */
async function sessionLike(root, name, owner, { ageMs = 0, extra } = {}) {
  const dir = join(root, name);
  await mkdir(join(dir, "P1v1", "files"), { recursive: true });
  if (owner !== undefined) await writeFile(join(dir, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
  if (extra) await writeFile(join(dir, extra), "not ours");
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    await utimes(dir, t, t);
  }
  return dir;
}

test("sweepStaleSessionDirs: same host and dead pid, any host after 24 h, unowned after 1 h; never live or foreign dirs", async () => {
  const root = await ensurePrototypeRoot(join(await tmp(), "r"));
  const host = hostname();
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 25 * HOUR).toISOString();
  const dead = await deadPid();

  const mine = await createSessionDir(root, "mine");
  const mineOld = await createSessionDir(root, "mine-old");
  await writeFile(join(mineOld, "owner.json"), JSON.stringify({ pid: process.pid, host, createdAt: old }));
  const deadHere = await sessionLike(root, "dead-abc123", { pid: dead, host, createdAt: now });
  const parent = await sessionLike(root, "parent-abc123", { pid: process.ppid, host, createdAt: now });
  const elsewhere = await sessionLike(root, "remote-abc123", { pid: dead, host: "another-host", createdAt: now });
  const elsewhereOld = await sessionLike(root, "remote-old123", { pid: 1, host: "another-host", createdAt: old });
  const liveOld = await sessionLike(root, "liveold-abc123", { pid: process.ppid, host, createdAt: old });
  const samePid = await sessionLike(root, "samepid-abc123", { pid: process.pid, host, createdAt: now });
  const unownedYoung = await sessionLike(root, "unowned-abc123", undefined);
  const unownedOld = await sessionLike(root, "unowned-old123", undefined, { ageMs: 2 * HOUR });
  const garbageOld = await sessionLike(root, "garbage-old123", "{not json", { ageMs: 2 * HOUR });
  const foreignOld = await sessionLike(root, "foreign-old123", { pid: dead, host, createdAt: old }, { extra: "notes.txt" });
  const foreignName = join(root, "not-a-session");
  await mkdir(foreignName);
  const t = new Date(Date.now() - 48 * HOUR);
  await utimes(foreignName, t, t);

  const n = await sweepStaleSessionDirs(root);
  const gone = [deadHere, elsewhereOld, liveOld, unownedOld, garbageOld];
  const kept = [mine, mineOld, parent, elsewhere, samePid, unownedYoung, foreignOld, foreignName];
  for (const d of gone) assert.equal(existsSync(d), false, `removed: ${d}`);
  for (const d of kept) assert.ok(existsSync(d), `kept: ${d}`);
  assert.equal(n, gone.length);
  assert.equal(await sweepStaleSessionDirs(join(root, "does-not-exist")), 0);

  // Once this process releases its own session, the 24-hour rule applies to it like any other.
  releaseSessionDir(mineOld);
  assert.equal(await sweepStaleSessionDirs(root), 1);
  assert.equal(existsSync(mineOld), false);
  assert.ok(existsSync(mine));
});

test("public prototype materialization removes opaque configured secrets", async (t) => {
  const secret = "opaque-configured-key-Q7m2R9z4";
  process.env.OPENAI_COMPATIBLE_API_KEY = secret;
  t.after(() => delete process.env.OPENAI_COMPATIBLE_API_KEY);
  const dir = await tmp();
  const files = await materializeFiles(dir, [{ path: "index.html", content: `<p>${secret}</p>` }], { redactContent: true });
  assert.ok(!JSON.stringify(files).includes(secret));
  assert.ok(!(await readFile(join(dir, "index.html"), "utf8")).includes(secret));
  await assert.rejects(materializeFiles(dir, [{ path: `${secret}.html`, content: "test" }], { redactContent: true }), /sensitive public prototype file path/);
  assert.ok(!existsSync(join(dir, `${secret}.html`)));
});
