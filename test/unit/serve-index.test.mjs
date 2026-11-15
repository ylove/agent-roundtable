import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIndex, indexRoutes } from "../../dist/serve/index.js";
import { executionStatus } from "../../dist/execution/run-admin.js";
import { frozenRun, makeContract } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";
import { newExecutionId, executionTag } from "../../dist/ids.js";
import { runCli } from "../../dist/cli.js";
import { registerDuel, unregisterDuel, persistedLiveDuels } from "../../dist/table/live-duels.js";

test("serve index pure renderer escapes fixture content and has only external assets", async () => {
  const { store } = await frozenRun(makeContract({ title: '<script>alert("bad")</script>' }));
  const report = await executionStatus(store.id);
  const html = renderIndex("/capability/", [{ report, lastEvent: "2026-01-01" }], [{ id: "duel-archive", topic: "<img src=x onerror=bad>", winner: "A" }], [], "<script>bad()</script>");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes(`/capability/x/${store.id}/escalations`));
  assert.ok(html.includes("2026-01-01"));
  assert.deepEqual(inlineProblems(html), []);
  assert.ok(indexRoutes().every(route => !route.methods || route.methods.every(m => ["GET", "HEAD"].includes(m))));
});

test("serve index rejects invalid and unknown ids before opening a store", async () => {
  const route = indexRoutes().find(route => route.path instanceof RegExp && route.path.source.includes("x"));
  for (const id of ["bad", "%2e%2e", "%2Fetc", newExecutionId()]) {
    let notFound = false;
    await route.handler({ match: route.path.exec(`/x/${id}/`), notFound() { notFound = true; } });
    assert.equal(notFound, true, id);
  }
});

test("serve live duel registry is visible to the separate index and unregisters", () => {
  const duel = { id: "duel-index-fixture", agents: ["a", "b"], started: new Date().toISOString() };
  registerDuel(duel);
  try { assert.ok(persistedLiveDuels().some(d => d.id === duel.id)); }
  finally { unregisterDuel(duel.id); }
  assert.ok(!persistedLiveDuels().some(d => d.id === duel.id));
});

test("serve check-in status command accepts its six-character run tag", async t => {
  const { store } = await frozenRun();
  const output = [];
  t.mock.method(process.stdout, "write", text => { output.push(text); return true; });
  await runCli(["status", executionTag(store.id), "--json"]);
  assert.equal(JSON.parse(output.join("")).execution, store.id);
});
