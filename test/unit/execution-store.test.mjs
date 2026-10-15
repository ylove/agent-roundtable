import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { createExecutionStore, openExecutionStore, listExecutions, executionDir, REDUCER_VERSION } = await import("../../dist/execution/store.js");
const { verifyExecution } = await import("../../dist/execution/verify.js");
const { hashEvent, canonicalJSON, sha256Hex } = await import("../../dist/execution/chain.js");
const { EXECUTIONS_DIR } = await import("../../dist/config.js");
const { newExecutionId } = await import("../../dist/ids.js");
const { GENESIS_HASH } = await import("../../dist/execution/types.js");
const { runScript } = await import("../fixtures/execution/script.mjs");

const WORKER = fileURLToPath(new URL("../fixtures/execution/transact-worker.mjs", import.meta.url));
const opts = { repoRoot: "/srv/repo", baseSha: "abc123", agentsDir: "/srv/agents" };
const newStore = (extra = {}) => createExecutionStore({ ...opts, ...extra });
const src = { kind: "agent", id: "w1", pid: process.pid };
const note = (text) => ({ type: "note.posted", source: src, payload: { topic: "t", text, refs: [] } });
/** One transaction holding all the notes (one batch). */
const notes = (store, ...texts) => store.transact(() => ({ events: texts.map(note) }));
/** One transaction per note. */
async function notesEach(store, ...texts) {
  for (const t of texts) await store.transact(() => ({ events: [note(t)] }));
}
const eventsFile = (store) => join(store.dir, "events.jsonl");
const lines = (store) => readFileSync(eventsFile(store), "utf8").split("\n").filter(Boolean);

test("the test home is isolated", () => {
  assert.ok(EXECUTIONS_DIR.startsWith(process.env.ROUNDTABLE_HOME));
});

test("create lays out a private execution directory with an immutable header", async () => {
  const id = newExecutionId();
  const store = await newStore({ id });
  assert.equal(store.id, id);
  assert.equal(store.dir, join(EXECUTIONS_DIR, id));
  assert.equal(executionDir(id), store.dir);
  for (const d of ["", "contracts", "blobs"]) assert.equal(statSync(join(store.dir, d)).mode & 0o777, 0o700, d || "dir");
  for (const f of ["execution.json", "events.jsonl"]) assert.equal(statSync(join(store.dir, f)).mode & 0o777, 0o600, f);
  const header = JSON.parse(readFileSync(join(store.dir, "execution.json"), "utf8"));
  assert.deepEqual(header, store.header());
  assert.deepEqual(Object.keys(header), ["id", "schema", "repo_root", "base_sha", "agents_dir", "created"]);
  assert.equal(header.schema, 1);
  assert.equal(header.repo_root, "/srv/repo");
  store.header().id = "mutated";
  assert.equal(store.header().id, id, "header() returns a copy");
  await assert.rejects(newStore({ id }), /already exists/);
  await assert.rejects(newStore({ id: "../escape" }), /Not an execution id/);
  await assert.rejects(newStore({ baseSha: "" }), /baseSha is required/);
  await assert.rejects(openExecutionStore("exe-0000000000000000"), /not found/);
  await assert.rejects(openExecutionStore("exe-../../x"), /Not an execution id/);
  const reopened = await openExecutionStore(id);
  assert.deepEqual(reopened.header(), header);
  assert.ok((await listExecutions()).some((h) => h.id === id));
});

test("listExecutions skips interrupted creates and foreign entries, oldest first", async () => {
  const a = await newStore({ id: newExecutionId(Date.now() - 1000) });
  const b = await newStore();
  mkdirSync(join(EXECUTIONS_DIR, newExecutionId()), { recursive: true }); // no execution.json
  writeFileSync(join(EXECUTIONS_DIR, "notes.txt"), "x");
  const ids = (await listExecutions()).map((h) => h.id);
  assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id));
  assert.deepEqual(ids, [...ids].sort());
});

test("transact fills the envelope and chains hashes", async () => {
  const store = await newStore();
  const { events, result } = await store.transact(({ state, header }) => {
    assert.equal(state.seq, 0);
    assert.equal(header.id, store.id);
    return {
      events: [note("one"), { ...note("two"), mode: "deliberation", contract: "ctr-x-1", contract_version: 2, causation: "evt-a", correlation: "E1" }],
      result: "done",
    };
  });
  assert.equal(result, "done");
  const [e1, e2] = events;
  assert.deepEqual([e1.v, e1.seq, e2.seq], [1, 1, 2]);
  assert.match(e1.id, /^evt-[0-9a-hjkmnp-tv-z]{8}$/);
  assert.equal(e1.execution, store.id);
  assert.equal(e1.mode, "execution");
  assert.equal(e2.mode, "deliberation");
  assert.deepEqual([e2.contract, e2.contract_version, e2.causation, e2.correlation], ["ctr-x-1", 2, "evt-a", "E1"]);
  assert.equal("contract" in e1, false, "absent optional fields are omitted, not undefined");
  assert.ok(!Number.isNaN(Date.parse(e1.ts)));
  assert.equal(e1.prev, GENESIS_HASH);
  assert.equal(e2.prev, e1.hash);
  assert.equal(e1.hash, hashEvent(e1.prev, e1));
  assert.deepEqual(lines(store).map((l) => JSON.parse(l)), events);
  const s = await store.state();
  assert.deepEqual([s.seq, s.hash, s.notes.length], [2, e2.hash, 2]);
  assert.deepEqual(await store.transact(() => ({ events: [] })), { events: [], result: undefined });
});

test("fn always sees fresh state, including other instances' writes", async () => {
  const a = await newStore();
  const b = await openExecutionStore(a.id);
  await notes(a, "x", "y");
  const { result } = await b.transact(({ state }) => ({ events: [note("z")], result: state.seq }));
  assert.equal(result, 2);
  assert.equal((await a.state()).seq, 3, "reads tail without a lock");
  // Concurrent transactions within one process are serialized too.
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).transact(({ state }) => ({ events: [note(`p${i}:${state.seq}`)] }))));
  const all = await a.events();
  assert.deepEqual(all.map((e) => e.seq), Array.from({ length: 23 }, (_, i) => i + 1));
  for (const e of all.slice(3)) assert.equal(Number(e.payload.text.split(":")[1]), e.seq - 1);
  assert.deepEqual(await a.verify(), { ok: true, seq: 23 });
});

test("a throwing fn writes nothing and releases the lock", async () => {
  const store = await newStore();
  await assert.rejects(store.transact(() => { throw new Error("nope"); }), /nope/);
  await assert.rejects(store.transact(() => ({ nothing: true })), /must return \{ events/);
  assert.equal(existsSync(join(store.dir, "events.lock")), false);
  await notes(store, "after");
  assert.equal((await store.state()).seq, 1);
});

test("state() returns a copy and events() filters", async () => {
  const store = await newStore();
  await notes(store, "a", "b");
  await store.transact(() => ({ events: [{ type: "watchdog.stall_detected", source: src, payload: { agent: "w1" } }, note("c")] }));
  const s = await store.state();
  s.notes.length = 0;
  assert.equal((await store.state()).notes.length, 3);
  assert.deepEqual((await store.events()).map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual((await store.events({ sinceSeq: 2 })).map((e) => e.seq), [3, 4]);
  assert.deepEqual((await store.events({ types: ["watchdog.stall_detected"] })).map((e) => e.seq), [3]);
  assert.deepEqual((await store.events({ limit: 3, sinceSeq: 1 })).map((e) => e.seq), [2, 3, 4].slice(0, 3));
  assert.deepEqual((await store.events({ sinceSeq: 4 })), []);
  assert.deepEqual((await store.events({ limit: 0 })), []);
  const other = await openExecutionStore(store.id);
  await notes(other, "d");
  assert.deepEqual((await store.events({ sinceSeq: 4 })).map((e) => e.seq), [5], "a poller sees events written elsewhere");
});

// ---------------------------------------------------------------------------
// Concurrency across processes
// ---------------------------------------------------------------------------

function runWorker(id, name, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, id, name, String(count)], {
      env: { ...process.env, ROUNDTABLE_HOME: process.env.ROUNDTABLE_HOME },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(err) : reject(new Error(`${name} exited ${code}: ${err}`))));
  });
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((r) => child.once("spawn", r));
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  return pid;
}

test("4 processes x 200 transactions: gap-free seqs, a valid chain, no torn lines", { timeout: 120_000 }, async () => {
  const store = await newStore();
  // Start behind a stale lock left by a dead process: all four race to steal it.
  const lockDir = join(store.dir, "events.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: await deadPid(), host: hostname(), token: "dead", at: new Date().toISOString() }));

  const names = ["w1", "w2", "w3", "w4"];
  await Promise.all(names.map((n) => runWorker(store.id, n, 200)));

  const raw = readFileSync(eventsFile(store), "utf8");
  assert.ok(raw.endsWith("\n"), "the log ends on a complete line");
  const parsed = raw.slice(0, -1).split("\n").map((l) => JSON.parse(l));
  assert.equal(parsed.length, 800);
  assert.deepEqual(parsed.map((e) => e.seq), Array.from({ length: 800 }, (_, i) => i + 1));
  assert.deepEqual(await verifyExecution(store.id), { ok: true, seq: 800 });

  const next = new Map(names.map((n) => [n, 0]));
  for (const e of parsed) {
    const [name, i, seen] = e.payload.text.split(":");
    assert.equal(Number(i), next.get(name), `${name} transactions stay in order`);
    next.set(name, Number(i) + 1);
    assert.equal(Number(seen), e.seq - 1, "every fn ran against the state just before its own event");
  }
  const s = await store.state();
  assert.deepEqual([s.seq, s.notes.length], [800, 800]);
  assert.equal(existsSync(lockDir), false);
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const snapshotPath = (store) => join(store.dir, "snapshot.json");
const marker = { seq: 0, agent: "snapshot-marker", topic: "m", text: "m", refs: [] };
/** Edit snapshot.json; with rehash, keep its state digest consistent (as a careful forger would). */
function editSnapshot(store, edit, rehash = true) {
  const snap = JSON.parse(readFileSync(snapshotPath(store), "utf8"));
  edit(snap);
  if (rehash) snap.state_sha256 = sha256Hex(canonicalJSON(snap.state));
  writeFileSync(snapshotPath(store), JSON.stringify(snap));
}
const hasMarker = (s) => s.notes.some((n) => n.agent === "snapshot-marker");

test("snapshot plus tail replay equals a full replay", async () => {
  const store = await newStore();
  const { length } = await runScript(store, { stopAfter: 12 });
  const written = await store.writeSnapshot();
  assert.equal(written.seq, 12);
  assert.equal(statSync(snapshotPath(store)).mode & 0o777, 0o600);
  const snap = JSON.parse(readFileSync(snapshotPath(store), "utf8"));
  assert.deepEqual(Object.keys(snap).sort(), ["hash", "offset", "reducer_version", "seq", "state", "state_sha256"]);
  assert.equal(snap.state_sha256, sha256Hex(canonicalJSON(snap.state)));
  assert.equal(snap.reducer_version, REDUCER_VERSION);
  assert.equal(snap.offset, statSync(eventsFile(store)).size);
  await runScript(store, { from: 12 });
  assert.equal((await store.state()).seq, length);

  const fromSnapshot = await (await openExecutionStore(store.id)).state();
  rmSync(snapshotPath(store));
  const full = await (await openExecutionStore(store.id)).state();
  assert.deepEqual(fromSnapshot, full);
  assert.deepEqual(full, await store.state(), "the writer's in-memory state matches too");
  assert.equal(full.tasks.b.state, "ready");
});

test("a valid snapshot is used; a wrong reducer_version or a mismatched hash is ignored", async () => {
  const store = await newStore();
  await notesEach(store, "1", "2", "3");
  await store.writeSnapshot();
  await notesEach(store, "4");

  editSnapshot(store, (s) => s.state.notes.push(marker), false);
  let s = await (await openExecutionStore(store.id)).state();
  assert.ok(!hasMarker(s), "a state that does not match its digest is not used");
  assert.equal(s.seq, 4);

  editSnapshot(store, () => {});
  editSnapshot(store, (s) => s.state.notes.push(marker));
  s = await (await openExecutionStore(store.id)).state();
  assert.ok(hasMarker(s), "the snapshot was loaded");
  assert.equal(s.seq, 4, "and the tail replayed on top of it");

  editSnapshot(store, (s) => (s.reducer_version = REDUCER_VERSION + 1));
  s = await (await openExecutionStore(store.id)).state();
  assert.ok(!hasMarker(s), "another reducer's snapshot is ignored");
  assert.equal(s.seq, 4);

  editSnapshot(store, (s) => {
    s.reducer_version = REDUCER_VERSION;
    s.hash = s.state.hash = "f".repeat(64);
  });
  s = await (await openExecutionStore(store.id)).state();
  assert.ok(!hasMarker(s), "a snapshot whose hash is not the event at its seq is ignored");

  editSnapshot(store, (s) => {
    const real = JSON.parse(lines(store)[2]);
    s.hash = s.state.hash = real.hash;
    s.offset -= 5;
  });
  s = await (await openExecutionStore(store.id)).state();
  assert.ok(!hasMarker(s), "a snapshot whose offset is not a line end is ignored");

  writeFileSync(snapshotPath(store), "{not json");
  assert.equal((await (await openExecutionStore(store.id)).state()).seq, 4);
});

// ---------------------------------------------------------------------------
// Tampering, torn lines, corruption
// ---------------------------------------------------------------------------

test("editing one payload makes verify fail at that seq", async () => {
  const store = await newStore();
  await notesEach(store, "one", "two", "three", "four", "five");
  assert.deepEqual(await store.verify(), { ok: true, seq: 5 });
  const file = eventsFile(store);
  writeFileSync(file, readFileSync(file, "utf8").replace('"text":"three"', '"text":"THREE"'));
  const r = await store.verify();
  assert.deepEqual([r.ok, r.seq, r.badSeq], [false, 2, 3]);
  assert.match(r.reason, /hash does not match/);

  // Re-hashing the edited event does not help: the next event's prev no longer links.
  const ls = lines(store).map((l) => JSON.parse(l));
  ls[2].hash = hashEvent(ls[2].prev, ls[2]);
  writeFileSync(file, ls.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r2 = await verifyExecution(store.dir);
  assert.deepEqual([r2.ok, r2.badSeq], [false, 4]);
  assert.match(r2.reason, /prev does not match/);
});

test("a deleted line is a gap for readers and for verify", async () => {
  const store = await newStore();
  await notesEach(store, "1", "2", "3");
  const ls = lines(store);
  writeFileSync(eventsFile(store), [ls[0], ls[2]].join("\n") + "\n");
  const r = await verifyExecution(store.id);
  assert.deepEqual([r.ok, r.seq, r.badSeq], [false, 1, 2]);
  await assert.rejects(openExecutionStore(store.id), /gap.*expected seq 2, found 3/);
});

test("a torn trailing line is ignored until it completes, and a writer discards a dead one", async () => {
  const store = await newStore();
  await notesEach(store, "1", "2", "3", "4", "5", "6");
  const ls = lines(store);
  const last = ls[5] + "\n";
  truncateSync(eventsFile(store), Buffer.byteLength(ls.slice(0, 5).join("\n") + "\n"));

  const reader = await openExecutionStore(store.id);
  assert.equal((await reader.state()).seq, 5);
  appendFileSync(eventsFile(store), last.slice(0, 40));
  assert.equal((await reader.state()).seq, 5, "half a line is not read");
  assert.equal((await reader.events()).length, 5);
  assert.deepEqual(await reader.verify(), { ok: true, seq: 5 });
  appendFileSync(eventsFile(store), last.slice(40));
  assert.equal((await reader.state()).seq, 6, "the completed line is read");

  // A writer that died mid-append left a fragment: the next transaction (under the lock) cuts it off.
  appendFileSync(eventsFile(store), '{"v":1,"id":"evt-');
  const { events } = await reader.transact(() => ({ events: [note("7")] }));
  assert.equal(events[0].seq, 7);
  assert.ok(readFileSync(eventsFile(store), "utf8").endsWith("\n"));
  assert.deepEqual(await reader.verify(), { ok: true, seq: 7 });
});

test("a corrupt complete line throws for readers and fails verify", async () => {
  const store = await newStore();
  await notes(store, "1", "2");
  appendFileSync(eventsFile(store), "this is not json\n");
  await assert.rejects(store.state(), /Corrupt event line/);
  await assert.rejects(store.transact(() => ({ events: [note("3")] })), /Corrupt event line/);
  await assert.rejects(openExecutionStore(store.id), /Corrupt event line/);
  await assert.rejects(store.events(), /Corrupt event line/);
  const r = await store.verify();
  assert.deepEqual([r.ok, r.seq, r.badSeq], [false, 2, 3]);
  assert.match(r.reason, /not valid JSON/);
});

test("a log that shrank under a reader is reported, not silently re-read", async () => {
  const store = await newStore();
  await notes(store, "1", "2");
  truncateSync(eventsFile(store), 0);
  await assert.rejects(store.state(), /shrank/);
});

test("contract.frozen must reference a stored contract blob", async () => {
  const store = await newStore();
  const frozen = (blob) => ({ type: "contract.frozen", source: src, payload: { contract: "ctr-abc123-1", version: 1, by: "main", hash: "h", ...(blob ? { blob } : {}) } });
  await assert.rejects(store.transact(() => ({ events: [frozen()] })), /payload\.blob is required/);
  await assert.rejects(store.transact(() => ({ events: [frozen(`sha256:${"a".repeat(64)}`)] })), /cannot read the contract blob.*not found/);
  const notContract = await store.putBlob(JSON.stringify({ hello: 1 }));
  await assert.rejects(store.transact(() => ({ events: [frozen(notContract)] })), /not a roundtable\.contract\/1 contract/);
  assert.equal((await store.state()).seq, 0, "nothing was written");
});

// ---------------------------------------------------------------------------
// Batch framing
// ---------------------------------------------------------------------------

test("a multi-event transaction is framed as one batch", async () => {
  const store = await newStore();
  const { events } = await notes(store, "a", "b", "c");
  assert.deepEqual(events.map((e) => e.batch), [{ n: 3, i: 0 }, { n: 3, i: 1 }, { n: 3, i: 2 }]);
  const { events: single } = await notes(store, "d");
  assert.equal("batch" in single[0], false, "a single event is not framed");
  assert.deepEqual(await store.verify(), { ok: true, seq: 4 });
});

test("a batch cut short by a crash is invisible to readers and cut off by the next writer", async () => {
  const store = await newStore();
  await notesEach(store, "1");
  await notes(store, "a", "b", "c");
  const ls = lines(store);
  // The writer died after two of its three lines reached the disk.
  writeFileSync(eventsFile(store), ls.slice(0, 3).join("\n") + "\n");
  const reader = await openExecutionStore(store.id);
  assert.equal((await reader.state()).seq, 1, "half a batch is not applied");
  assert.deepEqual((await reader.events()).map((e) => e.seq), [1]);
  assert.deepEqual(await reader.verify(), { ok: true, seq: 1 });
  const { events } = await reader.transact(({ state }) => ({ events: [note(`after ${state.seq}`)] }));
  assert.equal(events[0].seq, 2, "the incomplete batch was discarded under the lock");
  assert.deepEqual(await reader.verify(), { ok: true, seq: 2 });
  assert.equal(lines(store).length, 2);
});

test("an incomplete batch followed by another event fails verify and replay", async () => {
  const store = await newStore();
  await notes(store, "a", "b", "c");
  const [l1, l2] = lines(store);
  const second = JSON.parse(l2);
  const intruder = { ...JSON.parse(l1), seq: 3, id: "evt-intruder", prev: second.hash };
  delete intruder.batch;
  delete intruder.hash;
  intruder.hash = hashEvent(intruder.prev, intruder);
  writeFileSync(eventsFile(store), [l1, l2, JSON.stringify(intruder)].join("\n") + "\n");
  const r = await verifyExecution(store.id);
  assert.deepEqual([r.ok, r.seq, r.badSeq], [false, 0, 1]);
  assert.match(r.reason, /batch that starts at seq 1 is incomplete/);
  await assert.rejects(openExecutionStore(store.id), /incomplete/);
});

test("events() serves any sinceSeq correctly, including mid-batch", async () => {
  const store = await newStore();
  for (let i = 0; i < 10; i++) await notes(store, `x${i}`, `y${i}`);
  const reader = await openExecutionStore(store.id);
  for (const since of [0, 1, 2, 7, 13, 19, 20]) {
    const got = (await reader.events({ sinceSeq: since })).map((e) => e.seq);
    assert.deepEqual(got, Array.from({ length: 20 - since }, (_, i) => since + i + 1), `since ${since}`);
  }
  assert.deepEqual((await reader.events({ sinceSeq: 5, limit: 2 })).map((e) => e.seq), [6, 7]);
});
