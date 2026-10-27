import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneCastingArchives } from "../../dist/casting/retention.js";
import { sweepRetention } from "../../dist/execution/retention.js";
import { ROUNDTABLE_HOME } from "../../dist/config.js";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 22);
function archive(dir, name, days) {
  const path = join(dir, name);
  writeFileSync(path, "{}");
  const time = new Date(now - days * DAY);
  utimesSync(path, time, time);
}

test("casting retention prunes old casts and latest, keeping recent files and the cutoff", t => {
  const dir = mkdtempSync(join(tmpdir(), "casting-retention-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, days] of [["cast-old.json", 31], ["cast-recent.json", 29], ["cast-cutoff.json", 30], ["latest.json", 31], ["other.json", 40], ["cast-not-json.txt", 40]]) archive(dir, name, days);
  mkdirSync(join(dir, "cast-directory.json"));
  utimesSync(join(dir, "cast-directory.json"), new Date(now - 40 * DAY), new Date(now - 40 * DAY));
  assert.deepEqual(pruneCastingArchives(30, now, dir).sort(), ["cast-old.json", "latest.json"]);
  for (const name of ["cast-old.json", "latest.json"]) assert.equal(existsSync(join(dir, name)), false);
  for (const name of ["cast-recent.json", "cast-cutoff.json", "other.json", "cast-not-json.txt", "cast-directory.json"]) assert.ok(existsSync(join(dir, name)));
  assert.deepEqual(pruneCastingArchives(30, now, join(dir, "missing")), []);
});

test("casting retention keeps a recent latest when an old cast expires", t => {
  const dir = mkdtempSync(join(tmpdir(), "casting-retention-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  archive(dir, "cast-old.json", 31);
  archive(dir, "latest.json", 1);
  assert.deepEqual(pruneCastingArchives(30, now, dir), ["cast-old.json"]);
  assert.ok(existsSync(join(dir, "latest.json")));
});

test("retention sweep applies the session window to casting and honors 0, off and null", async t => {
  const dir = join(ROUNDTABLE_HOME, "casting");
  mkdirSync(dir, { recursive: true });
  const previous = process.env.ROUNDTABLE_SESSION_RETENTION_DAYS;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ROUNDTABLE_SESSION_RETENTION_DAYS;
    else process.env.ROUNDTABLE_SESSION_RETENTION_DAYS = previous;
  });
  archive(dir, "cast-old.json", 8);
  archive(dir, "cast-recent.json", 6);
  archive(dir, "latest.json", 8);
  const opts = { now, executionDays: null, auditDays: null };
  for (const value of ["0", "off"]) {
    process.env.ROUNDTABLE_SESSION_RETENTION_DAYS = value;
    assert.deepEqual((await sweepRetention(opts)).sessions, []);
    assert.ok(existsSync(join(dir, "cast-old.json")));
    assert.ok(existsSync(join(dir, "latest.json")));
  }
  process.env.ROUNDTABLE_SESSION_RETENTION_DAYS = "7";
  assert.deepEqual((await sweepRetention({ ...opts, sessionDays: null })).sessions, []);
  const report = await sweepRetention(opts);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.sessions.sort(), ["cast-old.json", "latest.json"]);
  assert.equal(existsSync(join(dir, "cast-old.json")), false);
  assert.equal(existsSync(join(dir, "latest.json")), false);
  assert.ok(existsSync(join(dir, "cast-recent.json")));
});
