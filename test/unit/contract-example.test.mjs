import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve names from the same personas users receive with the package.
process.env.ROUNDTABLE_AGENTS_DIR = fileURLToPath(new URL("../../examples/", import.meta.url));
const { checkContract, validateContract } = await import("../../dist/execution/contract.js");

test("the shipped three-task contract validates and every persona resolves", async () => {
  const example = JSON.parse(readFileSync(new URL("../../examples/contract.example.json", import.meta.url), "utf8"));
  const structural = checkContract(example);
  assert.equal(structural.ok, true, JSON.stringify(structural.errors));
  assert.deepEqual(structural.warnings, []);
  assert.equal(structural.contract.tasks.length, 3);
  const validated = await validateContract(example);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
  assert.deepEqual(validated.warnings, [], "persona resolution must succeed, not merely warn");
  assert.deepEqual(validated.contract, structural.contract);
});
