import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { appendAudit, verifyAudit, pruneAudit } = await import("../../dist/security/audit.js");
const { chainHash } = await import("../../dist/execution/chain.js");
const { AUDIT_DIR } = await import("../../dist/config.js");
const { GENESIS_HASH } = await import("../../dist/execution/types.js");

const freshDir = () => join(mkdtempSync(join(tmpdir(), "rt-audit-")), "audit");
const at = (y, m, d = 15) => Date.UTC(y, m - 1, d, 12);
const entries = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const FAKE_KEY = "sk-ant-test-0123456789abcdefghij";

test("the default audit directory is under the test home", async () => {
  assert.ok(AUDIT_DIR.startsWith(process.env.ROUNDTABLE_HOME));
  const e = await appendAudit({ actor: "human", action: "execution.confirmed", target: "exe-x" });
  assert.equal(e.prev, GENESIS_HASH);
  assert.equal((await verifyAudit()).ok, true);
});

test("entries chain across month files, in private files", async () => {
  const dir = freshDir();
  const a1 = await appendAudit({ actor: "main", action: "contract.frozen", target: "ctr-1", details: { hash: "h1" } }, { dir, now: at(2026, 8) });
  const a2 = await appendAudit({ actor: "main", action: "contract.excused", details: { agent: "w2", reason: "on leave" } }, { dir, now: at(2026, 8, 31) });
  const b1 = await appendAudit({ actor: "human", action: "execution.confirmed" }, { dir, now: at(2026, 9, 1) });
  const b2 = await appendAudit({ actor: "runner", action: "lease.violation", details: { paths: ["src/x"] } }, { dir, now: at(2026, 9, 2) });
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".jsonl")), ["audit-2026-08.jsonl", "audit-2026-09.jsonl"]);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const n of ["audit-2026-08.jsonl", "audit-2026-09.jsonl"]) assert.equal(statSync(join(dir, n)).mode & 0o777, 0o600);
  assert.equal(a1.prev, GENESIS_HASH);
  assert.equal(a2.prev, a1.hash);
  assert.equal(b1.prev, a2.hash, "the new month continues the chain from the newest earlier file");
  assert.equal(b2.prev, b1.hash);
  assert.equal(a1.hash, chainHash(a1.prev, a1));
  assert.deepEqual(entries(dir, "audit-2026-09.jsonl"), [b1, b2]);
  assert.deepEqual(Object.keys(a1), ["v", "ts", "pid", "actor", "action", "target", "details", "prev", "hash"]);
  assert.deepEqual(await verifyAudit({ dir }), { ok: true, entries: 4, files: 2 });
  assert.equal(existsSync(join(dir, "audit.lock")), false);
});

test("a clock that went back still appends to the newest file", async () => {
  const dir = freshDir();
  await appendAudit({ actor: "a", action: "x" }, { dir, now: at(2026, 9) });
  await appendAudit({ actor: "a", action: "y" }, { dir, now: at(2026, 7) });
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".jsonl")), ["audit-2026-09.jsonl"]);
  assert.equal((await verifyAudit({ dir })).entries, 2);
});

test("details and target are scrubbed of secrets", async () => {
  const dir = freshDir();
  const e = await appendAudit(
    { actor: "main", action: "execution.confirmed", target: `exe-1 ${FAKE_KEY}`, details: { confirmation: `go, key ${FAKE_KEY}`, nested: [{ k: FAKE_KEY }], n: 3 } },
    { dir }
  );
  const raw = readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith(".jsonl"))), "utf8");
  assert.doesNotMatch(raw, /sk-ant-test/);
  assert.match(e.details.confirmation, /\[redacted:api_key\]/);
  assert.equal(e.details.n, 3);
  assert.equal((await verifyAudit({ dir })).ok, true);
  await assert.rejects(appendAudit({ actor: "", action: "x" }, { dir }), /actor and action are required/);
  await assert.rejects(appendAudit({ actor: "a", action: "x", details: { bad: NaN } }, { dir }), /finite/);
  assert.equal((await verifyAudit({ dir })).entries, 1, "a refused entry writes nothing");
});

test("tampering is detected: an edited entry, a removed entry, a garbage line", async () => {
  const make = async () => {
    const dir = freshDir();
    for (const [i, m] of [[1, 8], [2, 8], [3, 9], [4, 9]]) await appendAudit({ actor: "a", action: `act-${i}` }, { dir, now: at(2026, m) });
    return dir;
  };
  let dir = await make();
  let file = join(dir, "audit-2026-08.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").replace("act-2", "act-X"));
  assert.deepEqual(await verifyAudit({ dir }), { ok: false, entries: 1, files: 2, badFile: "audit-2026-08.jsonl", badLine: 2, reason: "hash does not match its content" });

  dir = await make();
  file = join(dir, "audit-2026-08.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").split("\n")[0] + "\n");
  const r = await verifyAudit({ dir });
  assert.deepEqual([r.ok, r.badFile, r.badLine, r.reason], [false, "audit-2026-09.jsonl", 1, "prev does not link to the previous entry"]);

  dir = await make();
  appendFileSync(join(dir, "audit-2026-09.jsonl"), "garbage\n");
  assert.equal((await verifyAudit({ dir })).reason, "not valid JSON");
});

test("a torn last line is ignored by verify and cut off by the next append", async () => {
  const dir = freshDir();
  await appendAudit({ actor: "a", action: "one" }, { dir, now: at(2026, 9) });
  appendFileSync(join(dir, "audit-2026-09.jsonl"), '{"v":1,"ts":');
  assert.deepEqual(await verifyAudit({ dir }), { ok: true, entries: 1, files: 1 });
  await appendAudit({ actor: "a", action: "two" }, { dir, now: at(2026, 9) });
  assert.deepEqual(await verifyAudit({ dir }), { ok: true, entries: 2, files: 1 });
});

test("concurrent appends are serialized by the lock", async () => {
  const dir = freshDir();
  await Promise.all(Array.from({ length: 15 }, (_, i) => appendAudit({ actor: "a", action: `p${i}` }, { dir })));
  const r = await verifyAudit({ dir });
  assert.deepEqual([r.ok, r.entries], [true, 15]);
});

test("pruning deletes whole expired months, keeps the newest, re-anchors and is itself audited", async () => {
  const dir = freshDir();
  await appendAudit({ actor: "a", action: "jan" }, { dir, now: at(2024, 1) });
  await appendAudit({ actor: "a", action: "feb" }, { dir, now: at(2024, 2) });
  const jun = await appendAudit({ actor: "a", action: "jun" }, { dir, now: at(2025, 6) });
  const now = Date.UTC(2025, 6, 1); // 2025-07-01: Feb 2024 ended more than 365 days earlier, Jun 2025 did not
  assert.deepEqual(await pruneAudit(365, { dir, now }), ["audit-2024-01.jsonl", "audit-2024-02.jsonl"]);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".jsonl")), ["audit-2025-06.jsonl", "audit-2025-07.jsonl"]);
  assert.notEqual(jun.prev, GENESIS_HASH, "the oldest remaining entry links to a deleted file");
  const [pruned] = entries(dir, "audit-2025-07.jsonl");
  assert.equal(pruned.action, "audit.pruned");
  assert.deepEqual(pruned.details, { files: ["audit-2024-01.jsonl", "audit-2024-02.jsonl"], retention_days: 365 });
  assert.equal(pruned.prev, jun.hash);
  assert.deepEqual(await verifyAudit({ dir }), { ok: true, entries: 2, files: 2 });
  assert.deepEqual(await pruneAudit(365, { dir, now }), [], "nothing else is old enough");

  // The newest file survives even when everything is expired.
  assert.deepEqual(await pruneAudit(1, { dir, now: Date.UTC(2030, 0, 1) }), ["audit-2025-06.jsonl"]);
  assert.ok(readdirSync(dir).includes("audit-2025-07.jsonl"));
  assert.equal((await verifyAudit({ dir })).ok, true);
});
