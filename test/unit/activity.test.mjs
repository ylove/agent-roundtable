import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "roundtable-activity-"));
const log = join(root, "session-activity.jsonl");
const agentsDir = join(root, "agents");
mkdirSync(agentsDir);
writeFileSync(join(agentsDir, "subagent-Alpha.md"), "You are Alpha.");
writeFileSync(join(agentsDir, "beta.md"), "You are Beta.");
process.env.ROUNDTABLE_ACTIVITY_LOG = log;
process.env.ROUNDTABLE_AGENTS_DIR = agentsDir;
process.env.ROUNDTABLE_SKILLS_DIR = join(root, "skills");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = join(root, "transcripts");
process.env.ROUNDTABLE_PUBLISHER = "ntfy";
process.env.ROUNDTABLE_NTFY_URL = "http://publisher.test";
delete process.env.OPENAI_COMPATIBLE_API_KEY;
after(() => rmSync(root, { recursive: true, force: true }));

const { recordActivity, readActivity, recentActivityFor } = await import("../../dist/activity.js");
const { startMeeting, continueMeeting, endMeeting, meetings } = await import("../../dist/sessions/meetings.js");
const { startCollaboration, nudgeCollaboration, endCollaboration, collaborations } = await import("../../dist/sessions/collaborations.js");
const { ACTIVITY_LOG_MAX_ENTRIES } = await import("../../dist/config.js");

const entry = (session, extra = {}) => ({ session, kind: "meeting", agents: ["alpha"], topic: "topic", public: false, ...extra });
const baseUrl = "http://llm.test/v1";
function replies(t) {
  return stubFetch(t, (url, init, index) => {
    if (url.startsWith(baseUrl)) return json(200, { choices: [{ message: { content: `reply ${index}` } }] });
    assert.ok(url.startsWith("http://publisher.test"), `Unexpected request: ${url}`);
    return init.method === "POST" ? json(200, { id: "post" }) : new Response("", { status: 200 });
  });
}

test("recordActivity creates directories, timestamps and bounded excerpts, and keeps names path-free", () => {
  const path = join(root, "nested", "history.jsonl");
  recordActivity(entry("s1", { at: "2026-01-01T00:00:00.000Z", mode: "debate", agents: [join(agentsDir, "subagent-Alpha.md")], topic: "t".repeat(301), outcome: "o".repeat(601), public: true }), path);
  recordActivity(entry("s2"), path);
  const entries = readActivity(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    at: "2026-01-01T00:00:00.000Z", session: "s1", kind: "meeting", mode: "debate", agents: ["alpha"],
    topic: "t".repeat(299) + "…", outcome: "o".repeat(599) + "…", public: true,
  });
  assert.ok(Number.isFinite(Date.parse(entries[1].at)));
  assert.ok(!("outcome" in entries[1]));
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
});

test("activity is disabled with null, missing files read empty, and write failures never throw", (t) => {
  assert.deepEqual(readActivity(join(root, "absent.jsonl")), []);
  assert.doesNotThrow(() => recordActivity(entry("disabled"), null));
  assert.deepEqual(readActivity(null), []);
  assert.deepEqual(recentActivityFor("alpha", 5, null), []);
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  assert.doesNotThrow(() => recordActivity(entry("broken"), root));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not record activity/);
  assert.deepEqual(readActivity(root), []);
});

test("readActivity skips corrupt JSON and invalid entries while preserving valid lines", () => {
  const path = join(root, "corrupt.jsonl");
  recordActivity(entry("valid1"), path);
  appendFileSync(path, '\nnot-json\nnull\n{}\n{"agents":42}\n');
  recordActivity(entry("valid2"), path);
  assert.deepEqual(readActivity(path).map((e) => e.session), ["valid1", "valid2"]);
});

test("recordActivity preserves already-canonical keys even when they contain a remaining prefix", () => {
  const path = join(root, "canonical.jsonl");
  recordActivity(entry("canonical", { agents: ["subagent-alpha"] }), path);
  assert.deepEqual(readActivity(path)[0].agents, ["subagent-alpha"]);
});

test("rotation happens only above 120 percent, retaining the newest MAX entries", () => {
  const path = join(root, "rotation.jsonl");
  const threshold = 1.2 * ACTIVITY_LOG_MAX_ENTRIES;
  const initial = Array.from({ length: threshold - 1 }, (_, index) => ({ ...entry(`s${index}`), at: new Date(index).toISOString() }));
  writeFileSync(path, initial.map(JSON.stringify).join("\n") + "\n");
  recordActivity(entry(`s${threshold - 1}`), path);
  assert.equal(readActivity(path).length, threshold);
  recordActivity(entry(`s${threshold}`), path);
  const entries = readActivity(path);
  assert.equal(entries.length, ACTIVITY_LOG_MAX_ENTRIES);
  assert.equal(entries[0].session, `s${threshold + 1 - ACTIVITY_LOG_MAX_ENTRIES}`);
  assert.equal(entries.at(-1).session, `s${threshold}`);
});

test("recentActivityFor filters by canonical agent key and returns newest first with a default limit of five", () => {
  const path = join(root, "recent.jsonl");
  for (let index = 0; index < 8; index++) recordActivity(entry(`s${index}`), path);
  recordActivity(entry("other", { agents: ["beta"] }), path);
  assert.deepEqual(recentActivityFor("alpha", undefined, path).map((e) => e.session), ["s7", "s6", "s5", "s4", "s3"]);
  assert.deepEqual(recentActivityFor("subagent-Alpha.md", 2, path).map((e) => e.session), ["s7", "s6"]);
  assert.deepEqual(recentActivityFor("missing", 5, path), []);
  assert.deepEqual(recentActivityFor("alpha", 0, path), []);
});

test("endMeeting records the summary or final assistant message and the agenda without private context", async (t) => {
  const calls = replies(t);
  const first = await startMeeting("alpha", "meeting-agenda", "private-context", "openai_compatible", "m", baseUrl, "debate");
  await continueMeeting(first.meetingId, "follow-up");
  const ended = await endMeeting(first.meetingId, true);
  assert.equal(ended, "reply 2");
  const activity = readActivity().find((e) => e.session === first.meetingId);
  assert.deepEqual({ ...activity, at: undefined }, {
    at: undefined, session: first.meetingId, kind: "meeting", mode: "debate", agents: ["alpha"],
    topic: "meeting-agenda", outcome: "reply 2", public: false,
  });
  assert.equal(calls.length, 3);
  assert.ok(!meetings.has(first.meetingId));
  const second = await startMeeting("beta", "agenda2", undefined, "openai_compatible", "m", baseUrl);
  await endMeeting(second.meetingId);
  assert.equal(readActivity().find((e) => e.session === second.meetingId).outcome, "reply 3");
  assert.equal(readActivity().filter((e) => e.session === second.meetingId).length, 1);
});

test("endCollaboration records participants and summary, excluding the final orchestrator nudge", async (t) => {
  replies(t);
  const opts = { provider: "openai_compatible", model: "m", baseUrl };
  const first = await startCollaboration(["alpha", "beta"], "collaboration-topic", opts);
  await nudgeCollaboration(first.collaborationId, "private nudge");
  await endCollaboration(first.collaborationId);
  const activity = readActivity().find((e) => e.session === first.collaborationId);
  assert.equal(activity.kind, "collaboration");
  assert.equal(activity.mode, "collaborate");
  assert.deepEqual(activity.agents, ["alpha", "beta"]);
  assert.equal(activity.topic, "collaboration-topic");
  assert.equal(activity.outcome, "reply 0");
  assert.equal(activity.public, false);
  assert.ok(!collaborations.has(first.collaborationId));
  const second = await startCollaboration(["alpha", "beta"], "topic2", opts);
  const ended = await endCollaboration(second.collaborationId, true);
  assert.equal(ended.summary, "reply 2");
  assert.equal(readActivity().find((e) => e.session === second.collaborationId).outcome, ended.summary);
});

test("public session end records public status while publisher requests stay stubbed", async (t) => {
  replies(t);
  const meeting = await startMeeting(join(agentsDir, "subagent-Alpha.md"), "open agenda", "private-context", "openai_compatible", "m", baseUrl, "standard", undefined, true);
  await endMeeting(meeting.meetingId);
  const activity = readActivity().find((e) => e.session === meeting.meetingId);
  assert.equal(activity.public, true);
  assert.equal(activity.topic, "open agenda");
  assert.deepEqual(activity.agents, ["alpha"]);
  const collaboration = await startCollaboration(["alpha", "beta"], "open topic", { provider: "openai_compatible", model: "m", baseUrl, public: true });
  await endCollaboration(collaboration.collaborationId);
  assert.equal(readActivity().find((e) => e.session === collaboration.collaborationId).public, true);
});

test("failed activity writes do not break or retain ended sessions", async (t) => {
  replies(t);
  t.mock.method(console, "error", () => {});
  const meeting = await startMeeting("alpha", "agenda", undefined, "openai_compatible", "m", baseUrl);
  const collaboration = await startCollaboration(["alpha", "beta"], "topic", { provider: "openai_compatible", model: "m", baseUrl });
  rmSync(log, { force: true });
  mkdirSync(log);
  t.after(() => rmSync(log, { recursive: true, force: true }));
  await assert.doesNotReject(endMeeting(meeting.meetingId));
  await assert.doesNotReject(endCollaboration(collaboration.collaborationId));
  assert.ok(!meetings.has(meeting.meetingId));
  assert.ok(!collaborations.has(collaboration.collaborationId));
  assert.ok(existsSync(log));
});
