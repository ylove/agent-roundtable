// ROUNDTABLE_DOTENV=off: the server never loads .env (worker MCP servers start keyless).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

// A package directory of its own: dist/env.js loads the .env beside it, so the repo's .env is never touched.
const pkg = mkdtempSync(join(tmpdir(), "rt-dotenv-"));
after(() => rmSync(pkg, { recursive: true, force: true }));
mkdirSync(join(pkg, "dist"));
copyFileSync(join(repo, "dist", "env.js"), join(pkg, "dist", "env.js"));
copyFileSync(join(repo, "dist", "user-config.js"), join(pkg, "dist", "user-config.js"));
mkdirSync(join(pkg, "dist", "runtimes"));
copyFileSync(join(repo, "dist", "runtimes", "spec.js"), join(pkg, "dist", "runtimes", "spec.js"));
copyFileSync(join(repo, "dist", "provider-ids.js"), join(pkg, "dist", "provider-ids.js"));
symlinkSync(join(repo, "node_modules"), join(pkg, "node_modules"), "dir");
writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
writeFileSync(join(pkg, ".env"), "RT_DOTENV_PROBE=from-dotenv\nANTHROPIC_API_KEY=sk-ant-from-dotenv-file\n");

/** Import env.js in a fresh process and report what it left in process.env. */
function load(extraEnv) {
  const script =
    `await import(${JSON.stringify(pathToFileURL(join(pkg, "dist", "env.js")).href)});\n` +
    `process.stdout.write(JSON.stringify({ probe: process.env.RT_DOTENV_PROBE ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: join(pkg, "home"), ROUNDTABLE_HOME: join(pkg, "state"), ...extraEnv },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test(".env is loaded by default and preserves the host's values", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(load({}), { probe: "from-dotenv", key: "sk-ant-from-dotenv-file" });
  assert.equal(load({ ANTHROPIC_API_KEY: "from-host" }).key, "from-host");
  assert.equal(load({ ANTHROPIC_API_KEY: "" }).key, "");
});

test("ROUNDTABLE_DOTENV=off skips .env entirely", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(load({ ROUNDTABLE_DOTENV: "off" }), { probe: null, key: null });
  assert.deepEqual(load({ ROUNDTABLE_DOTENV: " OFF " }), { probe: null, key: null });
  assert.equal(load({ ROUNDTABLE_DOTENV: "off", ANTHROPIC_API_KEY: "from-launcher" }).key, "from-launcher");
});
