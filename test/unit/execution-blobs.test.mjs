import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { putBlob, getBlob, blobPath, blobHex, scrubbedJSON, scrubDeep } = await import("../../dist/execution/blobs.js");
const { createExecutionStore } = await import("../../dist/execution/store.js");

const freshDir = () => mkdtempSync(join(tmpdir(), "rt-blobs-"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const FAKE_KEY = "sk-ant-test-0123456789abcdefghij";

test("blobs round-trip at sha256/<prefix>/<hex> with private modes", () => {
  const dir = freshDir();
  const ref = putBlob(dir, "hello diff\n");
  const hex = sha("hello diff\n");
  assert.equal(ref, `sha256:${hex}`);
  assert.equal(blobHex(ref), hex);
  const path = join(dir, "sha256", hex.slice(0, 2), hex);
  assert.equal(blobPath(dir, ref), path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "sha256", hex.slice(0, 2))).mode & 0o777, 0o700);
  assert.deepEqual(getBlob(dir, ref), Buffer.from("hello diff\n"));
  assert.equal(putBlob(dir, Buffer.from("hello diff\n")), ref, "same content, same ref");
  assert.deepEqual(readdirSync(join(dir, "sha256", hex.slice(0, 2))), [hex], "no temp files left behind");
});

test("getBlob verifies the hash and rejects bad refs", () => {
  const dir = freshDir();
  const ref = putBlob(dir, "original");
  writeFileSync(blobPath(dir, ref), "tampered");
  assert.throws(() => getBlob(dir, ref), /corrupt/);
  assert.throws(() => getBlob(dir, `sha256:${"0".repeat(64)}`), /not found/);
  for (const bad of ["sha1:abc", `sha256:${"G".repeat(64)}`, "sha256:../../etc/passwd", ""]) {
    assert.throws(() => getBlob(dir, bad), /Not a blob ref/);
  }
});

test("re-putting content repairs a truncated or same-size damaged blob file", () => {
  const dir = freshDir();
  const ref = putBlob(dir, "complete content");
  writeFileSync(blobPath(dir, ref), "comp");
  assert.equal(putBlob(dir, "complete content"), ref);
  assert.equal(getBlob(dir, ref).toString(), "complete content");
  writeFileSync(blobPath(dir, ref), "COMPLETE CONTENT");
  assert.equal(putBlob(dir, "complete content"), ref);
  assert.equal(getBlob(dir, ref).toString(), "complete content", "same size is not enough: the hash is checked");
});

test("a missing blob directory is refused, never recreated", () => {
  const gone = join(freshDir(), "purged", "blobs");
  assert.throws(() => putBlob(gone, "x"), /does not exist/);
  assert.equal(existsSync(join(gone, "..")), false);
});

test("content is scrubbed of secrets before hashing and writing, unless redact is false", () => {
  const dir = freshDir();
  const ref = putBlob(dir, `output: key ${FAKE_KEY} done`);
  const stored = getBlob(dir, ref).toString();
  assert.equal(stored, "output: key [redacted:api_key] done");
  assert.equal(ref, `sha256:${sha(stored)}`, "the ref names the redacted content");
  const raw = putBlob(dir, `key ${FAKE_KEY}`, { redact: false });
  assert.match(getBlob(dir, raw).toString(), /sk-ant-test/);
  const fromBuffer = putBlob(dir, Buffer.from(`key ${FAKE_KEY}`));
  assert.equal(getBlob(dir, fromBuffer).toString(), "key [redacted:api_key]");
});

test("binary content must opt out of scrubbing", () => {
  const dir = freshDir();
  const bin = Buffer.from([0xff, 0xfe, 0x00, 0x81]);
  assert.throws(() => putBlob(dir, bin), /binary content cannot be scrubbed/);
  assert.deepEqual(getBlob(dir, putBlob(dir, bin, { redact: false })), bin);
  const bom = Buffer.from("﻿hello");
  assert.deepEqual(getBlob(dir, putBlob(dir, bom)), bom, "a byte-order mark survives scrubbing");
});

test("scrubbedJSON keeps structured data valid where text scrubbing would not", () => {
  const value = { usage: { inputTokens: 1234 }, note: `key ${FAKE_KEY}`, list: [{ token: "abc" }] };
  const json = scrubbedJSON(value);
  const back = JSON.parse(json);
  assert.equal(back.usage.inputTokens, 1234);
  assert.equal(back.note, "key [redacted:api_key]");
  assert.deepEqual(scrubDeep({ when: new Date(0) }).when, new Date(0), "non-plain objects pass through untouched");
  assert.throws(() => scrubbedJSON({ when: new Date(0) }), /not a plain object/);
});

test("the store's putBlob/getBlob use the execution's blobs directory", async () => {
  const store = await createExecutionStore({ repoRoot: "/srv/repo", baseSha: "abc", agentsDir: "/srv/agents" });
  const ref = await store.putBlob("turn 1");
  assert.equal((await store.getBlob(ref)).toString(), "turn 1");
  assert.equal(statSync(blobPath(join(store.dir, "blobs"), ref)).isFile(), true);
  assert.equal(readFileSync(blobPath(join(store.dir, "blobs"), ref), "utf8"), "turn 1");
});
