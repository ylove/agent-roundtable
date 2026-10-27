import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONNECTOR_TEXT_PREFIX, MAX_DESCRIPTION_BYTES, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH,
  sanitizeDescription, sanitizeInputSchema, connectorToolsDigest, connectorConfigDigest, checkConnectorPin,
} from "../../dist/connectors/pin.js";
import { allowedTools, startSeatConnectors } from "../../dist/table/seat-connectors.js";
import { acceptConnectorTools } from "../../dist/connectors/pin.js";
import { setConnectorConfig } from "../../dist/user-config.js";
import { runTableCli } from "../../dist/cli-table.js";
import { USAGE } from "../../dist/cli.js";

const SERVER = fileURLToPath(new URL("../fixtures/connectors/seat-server.mjs", import.meta.url));
const spec = (extra = {}) => ({ command: process.execPath, args: [SERVER], env: {}, ...extra });
const tool = (extra = {}) => ({ name: "lookup", description: "Look something up.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true }, ...extra });
const controls = [
  [0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
].flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => String.fromCodePoint(start + i))).join("");

function home(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-metadata-")));
  const old = process.env.ROUNDTABLE_HOME;
  process.env.ROUNDTABLE_HOME = dir;
  t.after(() => {
    if (old === undefined) delete process.env.ROUNDTABLE_HOME; else process.env.ROUNDTABLE_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const pins = dir => JSON.parse(readFileSync(join(dir, "connector-pins.json"), "utf8"));
async function startAndClose(names, dir) {
  const session = await startSeatConnectors(names, { home: dir });
  try { return session.turn("ada")?.tools; } finally { await session.close(); }
}
const sink = () => ({ text: "", write(s) { this.text += s; } });

test("descriptions strip controls and formatting, carry an untrusted prefix and fit 1 KiB", () => {
  assert.equal(sanitizeDescription(`Look${controls} here.`), CONNECTOR_TEXT_PREFIX + "Look here.");
  assert.equal(sanitizeDescription(undefined), CONNECTOR_TEXT_PREFIX);
  for (const description of ["x".repeat(3000), "é".repeat(1500), "😀".repeat(1000), "x" + "😀".repeat(1000)]) {
    const out = sanitizeDescription(description);
    assert.ok(out.startsWith(CONNECTOR_TEXT_PREFIX));
    assert.ok(Buffer.byteLength(out) <= MAX_DESCRIPTION_BYTES);
    assert.ok(out.endsWith("..."));
    assert.ok(out.isWellFormed());
  }
  const offered = allowedTools("desk", {}, [tool({ description: `Hi${controls}!` })]);
  assert.equal(offered[0].spec.description, CONNECTOR_TEXT_PREFIX + "Hi!");
});

test("schemas clean prose fields and omit schemas whose meaning-bearing text would change", () => {
  const schema = {
    type: "object", properties: { q: { type: "string", title: `T${controls}`, description: `A${controls}B`, enum: ["a b"] } },
    required: ["q"], $defs: JSON.parse('{"__proto__":{"type":"string"}}'),
  };
  const before = JSON.stringify(schema);
  const clean = sanitizeInputSchema(schema);
  assert.equal(clean.properties.q.description, "AB");
  assert.equal(clean.properties.q.title, "T");
  assert.deepEqual(clean.properties.q.enum, ["a b"]);
  assert.equal(JSON.stringify(schema), before);
  assert.ok(Object.hasOwn(clean.$defs, "__proto__"));
  assert.deepEqual(allowedTools("desk", {}, [tool({ inputSchema: schema })])[0].spec.inputSchema, clean);
  // Enum values, property names and similar text are never rewritten; the schema is left out instead.
  assert.equal(sanitizeInputSchema({ type: "object", properties: { s: { enum: ["\n", "\t"] } } }), undefined);
  assert.equal(sanitizeInputSchema({ type: "object", properties: { [`q${controls}`]: { type: "string" } } }), undefined);
  assert.deepEqual(allowedTools("desk", {}, [tool({ inputSchema: { type: "object", properties: { s: { enum: ["\n"] } } } })]), []);
  const credential = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  assert.ok(!sanitizeDescription(credential).includes("abcdefghijklmnopqrstuvwxyz"));
  const redacted = sanitizeInputSchema({ type: "object", description: credential });
  assert.ok(!JSON.stringify(redacted).includes("abcdefghijklmnopqrstuvwxyz"));
});

test("schema byte caps include keys, escaping and UTF-8; tools outside the bounds are omitted", () => {
  const base = { type: "object", description: "" };
  const room = MAX_SCHEMA_BYTES - Buffer.byteLength(JSON.stringify(base));
  const exact = { ...base, description: "x".repeat(room) };
  assert.deepEqual(sanitizeInputSchema(exact), exact);
  for (const schema of [
    { ...base, description: "x".repeat(room + 1) },
    { ...base, description: "é".repeat(room) },
    { ...base, description: '"'.repeat(room) },
    { type: "object", ["x".repeat(MAX_SCHEMA_BYTES)]: "string" },
  ]) {
    assert.equal(sanitizeInputSchema(schema), undefined);
    assert.deepEqual(allowedTools("desk", {}, [tool({ inputSchema: schema })]), []);
  }
});

test("schema depth is bounded at eight through objects and arrays", () => {
  for (const wrap of [value => ({ child: value }), value => [value]]) {
    let value = "leaf";
    for (let i = 1; i < MAX_SCHEMA_DEPTH; i++) value = wrap(value);
    assert.ok(sanitizeInputSchema({ type: "object", extension: value }));
    const deep = { type: "object", extension: wrap(value) };
    assert.equal(sanitizeInputSchema(deep), undefined);
    assert.deepEqual(allowedTools("desk", {}, [tool({ inputSchema: deep })]), []);
  }
});

test("tool digests use canonical raw metadata in name order and include readOnlyHint", () => {
  const a = tool(), b = tool({ name: "another" });
  const original = [a, b];
  const digest = connectorToolsDigest(original);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(connectorToolsDigest([b, { ...a, inputSchema: { properties: { q: { type: "string" } }, type: "object" } }]), digest);
  assert.deepEqual(original, [a, b]);
  const canonical = '[{"annotations":{"readOnlyHint":true},"description":"Look something up.","inputSchema":{"properties":{"q":{"type":"string"}},"type":"object"},"name":"lookup"}]';
  assert.equal(connectorToolsDigest([a]), createHash("sha256").update(canonical).digest("hex"));
  for (const changed of [
    tool({ name: "other" }), tool({ description: "Changed." }), tool({ description: a.description + "\u200b" }),
    tool({ inputSchema: { ...a.inputSchema, description: "Changed." } }),
    tool({ inputSchema: { type: "object", properties: { other: { type: "string" } } } }),
    tool({ annotations: { readOnlyHint: false } }), tool({ annotations: undefined }),
  ]) assert.notEqual(connectorToolsDigest([changed]), connectorToolsDigest([a]));
  assert.notEqual(connectorToolsDigest([]), connectorToolsDigest([a]));
  assert.equal(connectorToolsDigest([{ ...a, annotations: { readOnlyHint: true, title: "Other" } }]), connectorToolsDigest([a]));
});

test("config digests include command, ordered args, environment names and allowed tools only", () => {
  const initial = spec({ args: [SERVER, "one"], env: { REGION: "us", ACCOUNT: "one" }, tools: ["write", "post"] });
  const digest = connectorConfigDigest(initial);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(connectorConfigDigest({ ...initial, env: { ACCOUNT: "secret://env/OTHER_ACCOUNT", REGION: "eu" }, tools: ["post", "write"] }), digest);
  for (const changed of [
    { ...initial, command: "/other/command" }, { ...initial, args: ["one", SERVER] },
    { ...initial, env: { REGION: "us" } }, { ...initial, env: { ...initial.env, EXTRA: "yes" } },
    { ...initial, tools: ["write"] },
  ]) assert.notEqual(connectorConfigDigest(changed), digest);
  assert.equal(connectorConfigDigest(spec()), connectorConfigDigest(spec({ tools: [] })));
});

test("pin checks record a new config and require matching metadata for an accepted config", () => {
  const pin = { configDigest: "config", toolDigest: "tools" };
  assert.equal(checkConnectorPin(undefined, "config", "tools"), "record");
  assert.equal(checkConnectorPin(pin, "new-config", "new-tools"), "record");
  assert.equal(checkConnectorPin(pin, "config", "tools"), "match");
  assert.equal(checkConnectorPin(pin, "config", "new-tools"), "changed");
});

test("tools without readOnlyHint true require an explicit config entry and validated names", () => {
  const listed = [tool(), tool({ name: "absent", annotations: undefined }), tool({ name: "false", annotations: { readOnlyHint: false } }), tool({ name: "bad name", annotations: undefined })];
  assert.deepEqual(allowedTools("desk", {}, listed).map(t => t.tool), ["lookup"]);
  assert.deepEqual(allowedTools("desk", { tools: ["absent", "false", "bad name"] }, listed).map(t => t.tool), ["lookup", "absent", "false"]);
});

test("starts pin raw metadata privately; a changed list stops startup until connectors trust", async t => {
  const dir = home(t), pidFile = join(dir, "pids.log");
  const initial = spec({ env: { SEAT_FIXTURE_DESCRIPTION: "Look something up.", SEAT_FIXTURE_PID: pidFile } });
  setConnectorConfig("desk", initial, dir);
  setConnectorConfig("other", spec(), dir);
  const first = await startAndClose(["desk", "other"], dir);
  assert.equal(first.find(t => t.name === "desk__lookup").description, CONNECTOR_TEXT_PREFIX + "Look something up.");
  const accepted = pins(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "connector-pins.json")).mode & 0o777, 0o600);
  assert.equal(accepted.desk.configDigest, connectorConfigDigest(initial));
  const saved = readFileSync(join(dir, "connector-pins.json"), "utf8");
  for (const text of [SERVER, "Look something up.", "SEAT_FIXTURE_DESCRIPTION"]) assert.ok(!saved.includes(text));
  await startAndClose(["desk"], dir);
  assert.deepEqual(pins(dir), accepted);

  const changed = { ...initial, env: { ...initial.env, SEAT_FIXTURE_DESCRIPTION: "Look something up.\u200b" } };
  setConnectorConfig("desk", changed, dir);
  assert.equal(connectorConfigDigest(changed), accepted.desk.configDigest);
  await assert.rejects(startSeatConnectors(["other", "desk"], { home: dir }), {
    message: "Connector desk changed its tools since they were last accepted. Review it, then run: roundtable connectors trust desk",
  });
  assert.deepEqual(pins(dir), accepted);
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

  const output = sink();
  assert.equal(await runTableCli("connectors", ["trust", "desk"], { output }), 0);
  assert.match(output.text, /Connector desk: acceptance reset/);
  assert.ok(!output.text.includes("Look something up."));
  assert.deepEqual(pins(dir), { other: accepted.other });
  await startAndClose(["desk"], dir);
  assert.notEqual(pins(dir).desk.toolDigest, accepted.desk.toolDigest);
  await startAndClose(["desk"], dir);
});

test("config changes record new acceptance while tool opt-in remains explicit", async t => {
  const dir = home(t);
  setConnectorConfig("desk", spec(), dir);
  const first = await startAndClose(["desk"], dir);
  assert.ok(!first.some(t => t.name === "desk__post_note"));
  const accepted = pins(dir).desk;
  setConnectorConfig("desk", spec({ tools: ["post_note"], env: { SEAT_FIXTURE_DESCRIPTION: "Another description." } }), dir);
  const next = await startAndClose(["desk"], dir);
  assert.ok(next.some(t => t.name === "desk__post_note"));
  assert.notEqual(pins(dir).desk.configDigest, accepted.configDigest);
  assert.notEqual(pins(dir).desk.toolDigest, accepted.toolDigest);
});

test("present invalid pin files require trust, which rewrites them for the next start", async t => {
  const dir = home(t), file = join(dir, "connector-pins.json");
  setConnectorConfig("desk", spec(), dir);
  for (const invalid of ["not-json-private-text", "null", "[]", '{"desk":{}}', '{"other":{"toolDigest":"bad","configDigest":"bad"}}']) {
    writeFileSync(file, invalid, { mode: 0o600 });
    await assert.rejects(startSeatConnectors(["desk"], { home: dir }), error => {
      assert.match(error.message, /Unable to read connector pins.*roundtable connectors trust desk/);
      assert.ok(!error.message.includes("not-json-private-text"));
      return true;
    });
    assert.equal(readFileSync(file, "utf8"), invalid);
    assert.equal(await runTableCli("connectors", ["trust", "desk"], { output: sink() }), 0);
    assert.deepEqual(pins(dir), {});
    await startAndClose(["desk"], dir);
    assert.match(pins(dir).desk.toolDigest, /^[a-f0-9]{64}$/);
  }
});

test("an unreadable pin path is refused and trust rewrites it without following a link", async t => {
  const dir = home(t), target = join(dir, "absent.json"), file = join(dir, "connector-pins.json");
  setConnectorConfig("desk", spec(), dir);
  symlinkSync(target, file);
  await assert.rejects(startSeatConnectors(["desk"], { home: dir }), /roundtable connectors trust desk/);
  assert.equal(await runTableCli("connectors", ["trust", "desk"], { output: sink() }), 0);
  assert.deepEqual(pins(dir), {});
  assert.throws(() => statSync(target), { code: "ENOENT" });
  await startAndClose(["desk"], dir);
});

test("connectors trust requires a configured name, validates usage and appears in help", async t => {
  const dir = home(t), output = sink(), error = sink();
  for (const args of [[], ["list"], ["trust"], ["trust", "desk", "extra"]]) {
    assert.equal(await runTableCli("connectors", args, { output, error }), 2);
  }
  assert.equal(await runTableCli("connectors", ["trust", "desk"], { output, error }), 1);
  assert.match(error.text, /must be configured/);
  assert.throws(() => statSync(join(dir, "connector-pins.json")), { code: "ENOENT" });
  assert.equal(await runTableCli("connectors", ["--help"], { output }), 0);
  assert.match(output.text, /roundtable connectors trust <name>/);
  assert.match(USAGE, /roundtable connectors trust <name>/);
  setConnectorConfig("desk", spec(), dir);
  const result = spawnSync(process.execPath, ["dist/index.js", "connectors", "trust", "desk"], {
    env: { ...process.env, ROUNDTABLE_HOME: dir, ROUNDTABLE_DOTENV: "off" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Connector desk: acceptance reset/);
});

test("pin updates for different connectors keep each other's acceptance and release the lock", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pins-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  acceptConnectorTools("one", spec(), [tool()], dir);
  acceptConnectorTools("two", spec(), [tool()], dir);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "connector-pins.json"), "utf8"))).sort(), ["one", "two"]);
  assert.throws(() => acceptConnectorTools("one", spec(), [tool({ description: "changed" })], dir), /connectors trust one/);
  assert.throws(() => statSync(join(dir, "connector-pins.lock")));
});
