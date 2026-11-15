import { test } from "node:test";
import assert from "node:assert/strict";
import { fanout, parseSeat } from "../../dist/table/events.js";

test("fanout isolates synchronous and asynchronous observer failures", async () => {
  const event = { type: "end", winner: "tie", tally: { A: 1, B: 1 } };
  const received = [];
  const observer = fanout(
    { onEvent() { throw new Error("designer failed"); } },
    { async onEvent() { await Promise.resolve(); throw new Error("builder failed"); } },
    { onEvent(e) { received.push(["cfo", e]); } },
    { async onEvent(e) { await Promise.resolve(); received.push(["skeptic", e]); } },
  );

  await observer.onEvent(event);
  assert.deepEqual(received, [["cfo", event], ["skeptic", event]]);
  await fanout().onEvent(event);
});

test("parseSeat accepts agent references and provider/model overrides", () => {
  assert.deepEqual(parseSeat("designer"), { agent: "designer" });
  assert.deepEqual(parseSeat("builder=ollama"), { agent: "builder", provider: "ollama" });
  assert.deepEqual(parseSeat("cfo=ollama:builder"), {
    agent: "cfo", provider: "ollama", model: "builder",
  });
  assert.deepEqual(parseSeat("skeptic=ollama:builder/model:turbo:v2"), {
    agent: "skeptic", provider: "ollama", model: "builder/model:turbo:v2",
  });
  assert.deepEqual(parseSeat(" designer = ollama : builder/model:turbo "), {
    agent: "designer", provider: "ollama", model: "builder/model:turbo",
  });
});

test("parseSeat rejects empty agents, unknown providers, and empty models", () => {
  for (const input of ["", " ", "=ollama", " =ollama:builder"]) {
    assert.throws(() => parseSeat(input), /agent.*empty/i);
  }
  for (const input of ["builder=unknown", "builder=", "builder=constructor"]) {
    assert.throws(() => parseSeat(input), /unknown provider/i);
  }
  for (const input of ["skeptic=ollama:", "skeptic=ollama: "]) {
    assert.throws(() => parseSeat(input), /model.*empty/i);
  }
});
