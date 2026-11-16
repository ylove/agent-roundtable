import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { acquireLock, withLock, readLockOwner, LockTimeoutError } = await import("../../dist/execution/lock.js");

const LOCK_WORKER = fileURLToPath(new URL("../fixtures/execution/lock-worker.mjs", import.meta.url));
const LOCK_HOLDER = fileURLToPath(new URL("../fixtures/execution/lock-holder.mjs", import.meta.url));
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

test("a missing parent directory is refused, never recreated", async () => {
  const parent = join(freshDir(), "purged-execution");
  await assert.rejects(acquireLock(join(parent, "x.lock"), { staleMs: 10_000, timeoutMs: 1000 }), /does not exist/);
  assert.equal(existsSync(parent), false);
});

/** This process's start time as the lock records it (read from a lock we take). */
async function ownStarted() {
  const lockDir = join(freshDir(), "probe.lock");
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  const { started } = readLockOwner(lockDir);
  release();
  return started;
}

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

test("a live holder's lock is never taken, however old", async () => {
  const started = await ownStarted();
  assert.equal(typeof started, "string", "the lock records the holder's start time");
  const lockDir = join(freshDir(), "old.lock");
  plant(lockDir, { pid: process.pid, host: hostname(), token: "theirs", at: ago(3_600_000), started });
  await assert.rejects(
    acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 200 }),
    (e) => e instanceof LockTimeoutError && /never taken from a live process/.test(e.message)
  );
  assert.equal(readLockOwner(lockDir).token, "theirs");
  // Without a recorded start time a live pid is trusted too.
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token: "theirs", at: ago(3_600_000) }));
  await assert.rejects(acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 100 }), LockTimeoutError);
});

test("a live pid whose start time differs is a reused pid: its lock is cleared", async () => {
  const dir = freshDir();
  const lockDir = join(dir, "reused.lock");
  plant(lockDir, { pid: process.pid, host: hostname(), token: "theirs", at: ago(20_000), started: "Mon Jan 1 00:00:00 2001" });
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 1000 });
  assert.equal(readLockOwner(lockDir).token, release.token);
  assert.deepEqual(readdirSync(dir), ["reused.lock"], "the dead lock is removed, not left aside");
  release();
  // A fresh lock is not re-checked: pid reuse within staleMs is not plausible.
  plant(lockDir, { pid: process.pid, host: hostname(), token: "theirs", at: new Date().toISOString(), started: "Mon Jan 1 00:00:00 2001" });
  await assert.rejects(acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 100 }), LockTimeoutError);
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

test("another host's lock is never taken, however old", async () => {
  const lockDir = join(freshDir(), "remote.lock");
  const pid = await deadPid();
  plant(lockDir, { pid, host: `${hostname()}-elsewhere`, token: "remote", at: ago(3_600_000) });
  await assert.rejects(
    acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 100 }),
    (e) => e instanceof LockTimeoutError && /not this host/.test(e.message)
  );
  assert.equal(readLockOwner(lockDir).token, "remote");
});

test("a SIGSTOP'd holder keeps its lock: waiters time out instead of stealing", async () => {
  const lockDir = join(freshDir(), "stopped.lock");
  const child = spawn(process.execPath, [LOCK_HOLDER, lockDir], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const token = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        const m = /^held (\w+)\n/.exec(out);
        if (m) resolve(m[1]);
      });
      child.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
    });
    child.kill("SIGSTOP");
    await new Promise((r) => setTimeout(r, 120)); // well past the holder's staleMs of 50
    await assert.rejects(acquireLock(lockDir, { staleMs: 50, timeoutMs: 400 }), LockTimeoutError);
    assert.equal(readLockOwner(lockDir).token, token, "the stopped holder still owns the lock");
    child.kill("SIGCONT");
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r)));
  }
  // Once the holder is dead, its lock is cleared at once.
  const release = await acquireLock(lockDir, { staleMs: 50, timeoutMs: 2000 });
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

test("release while a contender has moved the lock aside does not orphan it", async (t) => {
  const lockDir = join(freshDir(), "displaced.lock");
  const options = { staleMs: 10_000, timeoutMs: 250 };
  const release = await acquireLock(lockDir, options);
  // A contender inspected a dead lock, then moved our replacement aside before checking its token.
  const aside = `${lockDir}.stale.contender`;
  renameSync(lockDir, aside);
  assert.equal(release(), false, "release runs before the contender restores our live lock");
  renameSync(aside, lockDir);
  assert.equal(readLockOwner(lockDir).token, release.token);

  // While the released token is still on disk, another active token with our pid stays protected.
  const activeDir = join(freshDir(), "active.lock");
  const active = await acquireLock(activeDir, options);
  t.after(() => active());
  await assert.rejects(acquireLock(activeDir, { ...options, timeoutMs: 50 }), LockTimeoutError);
  assert.equal(active.held(), true);

  const next = await acquireLock(lockDir, options);
  try {
    assert.notEqual(next.token, release.token);
    assert.equal(release(), false, "releasing the old token again is a no-op");
    assert.equal(next.held(), true);
  } finally {
    next();
  }
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

test("timeoutMs 0 still takes a dead holder's lock after clearing it", async () => {
  const lockDir = join(freshDir(), "once.lock");
  plant(lockDir, { pid: await deadPid(), host: hostname(), token: "dead", at: new Date().toISOString() });
  const release = await acquireLock(lockDir, { staleMs: 10_000, timeoutMs: 0 });
  assert.equal(release.held(), true);
  assert.equal(release(), true);
});

test("processes racing to steal a dead pid's lock keep mutual exclusion", { timeout: 120_000 }, async (t) => {
  const dir = freshDir();
  const lockDir = join(dir, "race.lock");
  const counter = join(dir, "counter");
  writeFileSync(counter, "0");
  // An old lock with a start time no live process has: cleared at once even if its pid was reused.
  plant(lockDir, { pid: await deadPid(), host: hostname(), token: "dead", at: ago(60_000), started: "Thu Jan  1 00:00:00 1970" });
  const workers = Array.from({ length: 4 }, (_, i) => {
    const child = spawn(process.execPath, [LOCK_WORKER, lockDir, counter, "25"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const failure = (code, signal) => new Error(`worker ${i} (pid ${child.pid}) exited ${code}, signal ${signal}; stderr:\n${err}`);
    const ready = new Promise((resolve, reject) => {
      child.once("message", (message) => (message === "ready" ? resolve() : reject(new Error(`worker ${i}: unexpected message ${message}`))));
      child.once("error", reject);
      child.once("close", (code, signal) => reject(failure(code, signal)));
    });
    // 'close' follows stderr closing, so failures include the complete worker diagnostic.
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => (code === 0 ? resolve() : reject(failure(code, signal))));
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    return { child, ready, done, closed, stderr: () => err };
  });
  let completed = false;
  t.after(async () => {
    const owner = readLockOwner(lockDir);
    const states = workers.map(({ child }) => ({
      pid: child.pid,
      running: child.exitCode === null && child.signalCode === null,
      code: child.exitCode,
      signal: child.signalCode,
    }));
    for (const [i, worker] of workers.entries()) {
      if (states[i].running) {
        worker.child.kill("SIGKILL");
      }
    }
    await Promise.all(workers.map((worker) => worker.closed));
    if (!completed) {
      // Keep the state from before cleanup, but wait for close to collect all stderr. The holder
      // named in a worker's timeout may differ from the owner still on disk when this test fails.
      const timeoutPids = new Set(workers.flatMap((worker) =>
        Array.from(worker.stderr().matchAll(/held by pid (\d+)/g), (match) => Number(match[1]))
      ));
      const holderPids = new Set([...timeoutPids, ...(owner ? [owner.pid] : [])]);
      t.diagnostic(`race lock owner before cleanup: ${owner ? JSON.stringify(owner) : "none"}`);
      for (const pid of timeoutPids) t.diagnostic(`LockTimeoutError reported holder pid ${pid}`);
      for (const pid of holderPids) {
        if (!states.some((state) => state.pid === pid)) {
          t.diagnostic(`holder pid ${pid} is not a race worker; running state and stderr unavailable`);
        }
      }
      for (const [i, state] of states.entries()) {
        t.diagnostic(`worker ${i} (pid ${state.pid}${holderPids.has(state.pid) ? ", lock holder" : ""}): running before cleanup=${state.running}, exit=${state.code}, signal=${state.signal}; stderr:\n${workers[i].stderr()}`);
      }
    }
  });
  await Promise.all([
    Promise.all(workers.map((worker) => worker.ready)).then(() =>
      Promise.all(workers.map(({ child }) => new Promise((resolve, reject) => {
        child.send("start", (error) => (error ? reject(error) : resolve()));
      })))
    ),
    Promise.all(workers.map((worker) => worker.done)),
  ]);
  assert.equal(readFileSync(counter, "utf8"), "100");
  assert.deepEqual(readdirSync(dir).sort(), ["counter"], "no lock or stale leftovers remain");
  completed = true;
});
