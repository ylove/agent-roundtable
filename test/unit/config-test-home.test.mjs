import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

const configUrl = new URL("../../dist/config.js", import.meta.url).href;
const storeUrl = new URL("../../dist/execution/store.js", import.meta.url).href;

test("node --test without the preload isolates store writes from HOME and warns once", () => {
  const root = mkdtempSync(join(tmpdir(), "roundtable-home-guard-"));
  try {
    const home = join(root, "home");
    const temp = join(root, "temp");
    mkdirSync(home);
    mkdirSync(temp);
    const fixture = join(root, "probe.test.mjs");
    const report = join(root, "report.json");
    writeFileSync(fixture, `
      import { test } from "node:test";
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      test("create real store state", async () => {
        assert.ok(process.env.NODE_TEST_CONTEXT, "Node set the test context itself");
        const config = await import(${JSON.stringify(configUrl)});
        const again = await import(${JSON.stringify(configUrl)});
        assert.equal(again.ROUNDTABLE_HOME, config.ROUNDTABLE_HOME);
        const { createExecutionStore } = await import(${JSON.stringify(storeUrl)});
        const store = await createExecutionStore({repoRoot: process.cwd(), baseSha: "abc", agentsDir: process.cwd()});
        writeFileSync(${JSON.stringify(report)}, JSON.stringify({home: config.ROUNDTABLE_HOME, dir: store.dir}));
      });
    `);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp };
    const probe = (extra = {}) => {
      // Deliberately no --import, NODE_OPTIONS, inherited state overrides or NODE_TEST_CONTEXT.
      const child = spawnSync(process.execPath, ["--test", fixture], {
        env: { ...env, ...extra }, encoding: "utf8", timeout: 20_000,
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const state = JSON.parse(readFileSync(report, "utf8"));
      assert.ok(existsSync(join(state.dir, "execution.json")), "the store actually wrote state");
      assert.deepEqual(readdirSync(home), [], "nothing was written anywhere under fake HOME");
      return { ...state, output: child.stdout + child.stderr };
    };
    const first = probe();
    const second = probe();
    assert.notEqual(first.home, second.home, "each test process gets a fresh directory");
    for (const result of [first, second]) {
      const rel = relative(temp, result.home);
      assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "fallback is under the temp root");
      assert.equal((result.output.match(/NODE_TEST_CONTEXT is set without ROUNDTABLE_HOME/g) ?? []).length, 1);
    }
    const explicit = join(root, "explicit-state");
    const configured = probe({ ROUNDTABLE_HOME: explicit });
    assert.equal(configured.home, explicit, "an explicit state root still wins in tests");
    assert.doesNotMatch(configured.output, /NODE_TEST_CONTEXT is set without ROUNDTABLE_HOME/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
