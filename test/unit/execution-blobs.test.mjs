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

test("structured blobs redact credential values and object keys", () => {
  const key = "sk-ant-" + "z".repeat(23);
  const value = {
    password: "hunter22", SECRET: "opaque", token: ["one", "two"],
    Api_Key: "opaque", authorization: "opaque", credential: "opaque",
    credentials: { value: "nested-value", password: "nested-password" },
    nested: { [key]: "ordinary text", password: "short" },
    author: "writer", authority: "local", id: "row-1", run_id: "run-1",
    usage: { inputTokens: 1234, output_tokens: 20 },
  };
  const out = JSON.parse(scrubbedJSON(value));
  for (const name of ["password", "SECRET", "Api_Key", "authorization", "credential"]) {
    assert.equal(out[name], "[redacted:secret]");
  }
  assert.deepEqual(out.token, ["[redacted:secret]", "[redacted:secret]"]);
  assert.deepEqual(out.credentials, { value: "nested-value", password: "[redacted:secret]" });
  assert.deepEqual(out.nested, { "[redacted:api_key]": "ordinary text", password: "[redacted:secret]" });
  assert.deepEqual(out.usage, value.usage);
  for (const name of ["author", "authority", "id", "run_id"]) assert.equal(out[name], value[name]);
  assert.equal(value.password, "hunter22");
});

test("scrubbedJSON preserves persona refs and nested dissents with auth-prefixed identifiers", () => {
  const value = {
    refs: { "auth-reviewer": "/agents/auth-reviewer.md", "authentication-reviewer": "reviewer", "tokenizer": "tokenizer" },
    dissents: {
      "auth-check": {
        spec: { id: "auth-check", by: "auth-reviewer", claim: "Review the login flow", tripwire: { kind: "task_state", task: "auth-api", state: "rejected" } },
        score: "vindicated", evidence: ["review-1"],
      },
    },
    credentials: { "auth-reviewer": { path: "/agents/auth-reviewer.md" } },
    token: [{ id: "auth-check", description: "Review the login flow" }],
    auth: "reviewer", authz: "reviewer", authentication: "reviewer",
    author: "writer", authority: "local", passwordless: "enabled", tokenization: "enabled",
  };
  assert.deepEqual(JSON.parse(scrubbedJSON(value)), value);
});

test("persona refs preserve credential-like identifiers while their values and nested fields are scrubbed", (t) => {
  const previous = process.env.ROUNDTABLE_SCRUB_LITERALS;
  const literal = "private-persona-ref-123456";
  process.env.ROUNDTABLE_SCRUB_LITERALS = JSON.stringify([literal]);
  t.after(() => {
    if (previous === undefined) delete process.env.ROUNDTABLE_SCRUB_LITERALS;
    else process.env.ROUNDTABLE_SCRUB_LITERALS = previous;
  });
  const refs = Object.fromEntries(["secret-scanner", "token-reviewer", "api-key-reviewer"].map(name => [name, `/agents/${name}.md`]));
  const value = {
    refs: { ...refs, configured: `/agents/${literal}.md`, shaped: `/agents/${FAKE_KEY}.md`,
      nested: { password: "hunter22", token: ["short", 1234] } },
    password: "hunter22", token: ["short", 1234], api_key: "opaque",
    nested: { secret: "opaque", refs },
  };
  const expected = {
    refs: { ...refs, configured: "/agents/[redacted:env:ROUNDTABLE_SCRUB_LITERALS].md", shaped: "/agents/[redacted:api_key].md",
      nested: { password: "[redacted:secret]", token: ["[redacted:secret]", "[redacted:secret]"] } },
    password: "[redacted:secret]", token: ["[redacted:secret]", "[redacted:secret]"], api_key: "[redacted:secret]",
    nested: { secret: "[redacted:secret]", refs },
  };
  assert.deepEqual(scrubDeep(value), expected);
  assert.deepEqual(JSON.parse(scrubbedJSON(value)), expected);
});

test("structured credential fields match normalized segments and redact only string or number leaves", () => {
  const fields = ["password", "PASSWD", "secret", "token", "Api_Key", "apikey", "access-key", "private.key",
    "authorization", "credential", "credentials", "client_secret", "bearer", "db-password", "service.token", "clientSecret", "accessKey"];
  for (const field of fields) {
    for (const value of ["hunter22", "", 1234, 0]) {
      assert.deepEqual(JSON.parse(scrubbedJSON({ [field]: value })), { [field]: "[redacted:secret]" }, field);
    }
    for (const value of [null, false, { id: "auth-reviewer", enabled: true }, [{ id: "auth-check" }]]) {
      assert.deepEqual(JSON.parse(scrubbedJSON({ [field]: value })), { [field]: value }, field);
    }
  }
});

test("object keys use token patterns and configured literals without assignment heuristics", (t) => {
  const previous = process.env.BLOB_TEST_SECRET;
  process.env.BLOB_TEST_SECRET = "configured-object-key-123456";
  t.after(() => {
    if (previous === undefined) delete process.env.BLOB_TEST_SECRET;
    else process.env.BLOB_TEST_SECRET = previous;
  });
  const preserved = { "password=hunter22": { id: "row-1" }, "Authorization: Bearer ordinary": { id: "row-2" } };
  assert.deepEqual(JSON.parse(scrubbedJSON(preserved)), preserved);
  for (const [key, marker] of [
    [FAKE_KEY, "api_key"],
    ["eyJabcdef.abcdefghi.abcdefgh", "jwt"],
    ["-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----", "private_key"],
    [process.env.BLOB_TEST_SECRET, "env:BLOB_TEST_SECRET"],
  ]) {
    assert.deepEqual(JSON.parse(scrubbedJSON({ [key]: { id: "row-1" } })), { [`[redacted:${marker}]`]: { id: "row-1" } });
  }
});

test("the store's putBlob/getBlob use the execution's blobs directory", async () => {
  const store = await createExecutionStore({ repoRoot: "/srv/repo", baseSha: "abc", agentsDir: "/srv/agents" });
  const ref = await store.putBlob("turn 1");
  assert.equal((await store.getBlob(ref)).toString(), "turn 1");
  assert.equal(statSync(blobPath(join(store.dir, "blobs"), ref)).isFile(), true);
  assert.equal(readFileSync(blobPath(join(store.dir, "blobs"), ref), "utf8"), "turn 1");
});
