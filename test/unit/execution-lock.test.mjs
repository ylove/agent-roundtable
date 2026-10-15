import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { acquireLock, withLock, readLockOwner, LockTimeoutError } = await import("../../dist/execution/lock.js");

const LOCK_WORKER = fileURLToPath(new URL("../fixtures/execution/lock-worker.mjs", import.meta.url));
const freshDir = () => mkdtempSync(join(tmpdir(), "rt-lock-"));

function plant(lockDir, owner) {
  mkdirSync(lockDir, { mode: 0o700 });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));
}

/** A pid that certainly belonged to a process and no longer does. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((r) => child.once("spawn", r));
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  return pid;
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();

test("acquire writes owner.json in a 0700 lock directory; release removes it", async () => {
  const lockDir = join(freshDir(), "a.lock");
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  assert.equal(statSync(lockDir).mode & 0o777, 0o700);
  const owner = readLockOwner(lockDir);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, hostname());
  assert.equal(owner.token, release.token);
  assert.ok(Date.parse(owner.at) <= Date.now());
  assert.deepEqual(readdirSync(lockDir), ["owner.json"]);
  assert.equal(release.held(), true);
  assert.equal(release(), true);
  assert.equal(existsSync(lockDir), false);
  assert.equal(release(), false, "a second release is a no-op");
});

test("a missing parent directory is created", async () => {
  const lockDir = join(freshDir(), "deep", "er", "x.lock");
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  assert.equal(release(), true);
});

test("a second acquirer waits with backoff until the holder releases", async () => {
  const lockDir = join(freshDir(), "w.lock");
  const first = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  let got = false;
  const second = acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 5000 }).then((r) => ((got = true), r));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got, false, "must not acquire while held");
  first();
  const release = await second;
  assert.equal(readLockOwner(lockDir).token, release.token);
  release();
});

test("a live pid's lock younger than staleMs is not stolen", async () => {
  const lockDir = join(freshDir(), "live.lock");
  plant(lockDir, { pid: process.pid, host: hostname(), token: "theirs", at: new Date().toISOString() });
  const t0 = Date.now();
  await assert.rejects(acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 150 }), (e) => {
    assert.ok(e instanceof LockTimeoutError);
    assert.equal(e.code, "ELOCKTIMEOUT");
    assert.match(e.message, new RegExp(`held by pid ${process.pid}`));
    return true;
  });
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(readLockOwner(lockDir).token, "theirs");
});

test("a live pid's lock older than staleMs is stolen", async () => {
  const dir = freshDir();
  const lockDir = join(dir, "old.lock");
  plant(lockDir, { pid: process.pid, host: hostname(), token: "theirs", at: ago(20_000) });
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  assert.equal(readLockOwner(lockDir).token, release.token);
  assert.deepEqual(readdirSync(dir), ["old.lock"], "the stolen lock is removed, not left aside");
  release();
});

test("a lock whose pid is dead on this host is stolen at once", async () => {
  const lockDir = join(freshDir(), "dead.lock");
  const pid = await deadPid();
  plant(lockDir, { pid, host: hostname(), token: "dead", at: new Date().toISOString() });
  const t0 = Date.now();
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 2000 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(readLockOwner(lockDir).pid, process.pid);
  release();
});

test("a dead pid on another host proves nothing: only age makes that lock stale", async () => {
  const lockDir = join(freshDir(), "remote.lock");
  const pid = await deadPid();
  plant(lockDir, { pid, host: `${hostname()}-elsewhere`, token: "remote", at: new Date().toISOString() });
  await assert.rejects(acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 100 }), LockTimeoutError);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid, host: "elsewhere", token: "remote", at: ago(60_000) }));
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  release();
});

test("a lock directory without owner.json is judged by its age", async () => {
  const lockDir = join(freshDir(), "bare.lock");
  mkdirSync(lockDir);
  await assert.rejects(acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 100 }), LockTimeoutError);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lockDir, old, old);
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  release();
});

test("release removes the lock only while owner.json carries our token", async () => {
  const lockDir = join(freshDir(), "token.lock");
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  // Someone stole it (as after holding past staleMs).
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token: "thief", at: new Date().toISOString() }));
  assert.equal(release.held(), false);
  assert.equal(release(), false);
  assert.equal(readLockOwner(lockDir).token, "thief");
});

test("withLock serializes critical sections and releases on throw", async () => {
  const lockDir = join(freshDir(), "with.lock");
  let active = 0;
  let maxActive = 0;
  const order = [];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      withLock(lockDir, { staleMs: 10_000, timeoutMs: 10_000, waitMs: 1 }, async (lock) => {
        assert.equal(lock.held(), true);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2));
        order.push(i);
        active--;
      })
    )
  );
  assert.equal(maxActive, 1);
  assert.equal(order.length, 12);
  await assert.rejects(withLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 }, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lockDir), false);
});

test("processes racing to steal a dead pid's lock keep mutual exclusion", async () => {
  const dir = freshDir();
  const lockDir = join(dir, "race.lock");
  const counter = join(dir, "counter");
  writeFileSync(counter, "0");
  plant(lockDir, { pid: await deadPid(), host: hostname(), token: "dead", at: new Date().toISOString() });
  const runs = Array.from({ length: 4 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [LOCK_WORKER, lockDir, counter, "25"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
    })
  );
  await Promise.all(runs);
  assert.equal(readFileSync(counter, "utf8"), "100");
  assert.deepEqual(readdirSync(dir).sort(), ["counter"], "no lock or stale leftovers remain");
});
