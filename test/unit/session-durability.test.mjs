import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { startMeeting, endMeeting } = await import("../../dist/sessions/meetings.js");
const { startCollaboration, endCollaboration } = await import("../../dist/sessions/collaborations.js");
const { startUltraplan, endUltraplan } = await import("../../dist/sessions/ultraplan.js");

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => resolve(here, "../fixtures/agents", n);
const sample = fx("sample.md");
const plain = fx("plain.md");
const LLM = "http://localhost:1234/v1";
const opts = { provider: "openai_compatible", model: "m", baseUrl: LLM };
const reply = (text = "reply") => json(200, { choices: [{ message: { content: text } }] });
const RANDOM = "[0-9a-hjkmnp-tv-z]{8}";

describe("durable random session ids", () => {
  test("meetings, collaborations and ultraplans get <prefix>-<8 random chars>, never a counter", async (t) => {
    stubFetch(t, () => reply());
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const m = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", LLM);
      const c = await startCollaboration([sample, plain], "topic", { ...opts, maxRounds: 1 });
      const u = await startUltraplan([sample], "task", opts);
      ids.push(m.meetingId, c.collaborationId, u.ultraplanId);
      await endMeeting(m.meetingId);
      await endCollaboration(c.collaborationId);
      await endUltraplan(u.ultraplanId);
    }
    for (const [i, id] of ids.entries()) {
      const prefix = ["meeting", "collab", "ultraplan"][i % 3];
      assert.match(id, new RegExp(`^${prefix}-${RANDOM}$`));
    }
    assert.equal(new Set(ids).size, ids.length);
  });
});
