// Every spawn gets an allowlisted environment: provider keys and publisher credentials never reach a child.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../fixtures/agents/sample.md");
const root = mkdtempSync(join(tmpdir(), "rt-child-env-"));
after(() => rmSync(root, { recursive: true, force: true }));

const PLANTED = {
  ANTHROPIC_API_KEY: "sk-ant-planted-anthropic-0001",
  OPENAI_API_KEY: "sk-planted-openai-0002",
  TOGETHER_API_KEY: "planted-together-0003",
  REPLICATE_API_TOKEN: "r8_planted-replicate-0004",
  OPENAI_COMPATIBLE_API_KEY: "planted-compatible-0005",
  ROUNDTABLE_WEBHOOK_AUTH_HEADER: "Authorization: Bearer planted-webhook-0006",
  ROUNDTABLE_NTFY_TOKEN: "tk_planted-ntfy-0007",
  GH_TOKEN: "ghp_planted-gh-0008",
};

/** Plant fake credentials in this process for one test. */
function plant(t, extra = {}) {
  const saved = {};
  for (const [k, v] of Object.entries({ ...PLANTED, ...extra })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A fake program on PATH that dumps its environment as JSON to `out`, then prints `stdout`. */
function fakeProgram(t, names, out, stdout = "") {
  const bin = mkdtempSync(join(root, "bin-"));
  for (const name of names) {
    const p = join(bin, name);
    // Drains stdin first (local meetings send the prompt there), then reports.
    writeFileSync(
      p,
      `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n` +
        `  process.stdout.write(${JSON.stringify(stdout)});\n});\n`
    );
    chmodSync(p, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
}

function assertNoPlanted(env, allowed = []) {
  for (const name of Object.keys(PLANTED)) {
    if (allowed.includes(name)) continue;
    assert.equal(env[name], undefined, `${name} reached the child`);
  }
  const text = JSON.stringify(env);
  for (const [name, value] of Object.entries(PLANTED)) {
    if (!allowed.includes(name)) assert.ok(!text.includes(value), `the value of ${name} reached the child`);
  }
  assert.ok(env.PATH, "PATH is passed");
}

async function waitFor(path, ms = 5000) {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  // The writer may still be mid-write: wait for parseable JSON.
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      if (Date.now() > end) throw new Error(`unreadable ${path}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const { startLocalMeeting, endLocalMeeting } = await import("../../dist/sessions/local-meetings.js");
const { workspaceSnapshot } = await import("../../dist/sessions/grounding.js");
const { openInBrowser } = await import("../../dist/prototypes/board.js");

test("local meeting: the claude CLI gets the local-meeting allowlist, never provider keys", { skip: process.platform === "win32" }, async (t) => {
  plant(t);
  const out = join(root, "claude-env.json");
  fakeProgram(t, ["claude"], out, "fake reply");
  const { meetingId, response } = await startLocalMeeting(sample, "agenda");
  assert.equal(response, "fake reply");
  await endLocalMeeting(meetingId);
  const env = JSON.parse(readFileSync(out, "utf8"));
  assertNoPlanted(env);
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.TERM, "dumb");
});

test("local meeting: ROUNDTABLE_WORKER_AUTH=api_key passes ANTHROPIC_API_KEY and nothing else", { skip: process.platform === "win32" }, async (t) => {
  plant(t, { ROUNDTABLE_WORKER_AUTH: "api_key" });
  const out = join(root, "claude-env-key.json");
  fakeProgram(t, ["claude"], out, "fake reply");
  const { meetingId } = await startLocalMeeting(sample, "agenda");
  await endLocalMeeting(meetingId);
  const env = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(env.ANTHROPIC_API_KEY, PLANTED.ANTHROPIC_API_KEY);
  assertNoPlanted(env, ["ANTHROPIC_API_KEY"]);
});

test("grounding: git gets the git allowlist", { skip: process.platform === "win32" }, async (t) => {
  plant(t);
  const out = join(root, "git-env.json");
  fakeProgram(t, ["git"], out, "main\n");
  const ws = mkdtempSync(join(root, "ws-"));
  const text = workspaceSnapshot(ws);
  assert.match(text, /Git branch:\nmain/);
  const env = JSON.parse(readFileSync(out, "utf8"));
  assertNoPlanted(env);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("board: the browser opener gets the open allowlist", { skip: process.platform === "win32" }, async (t) => {
  plant(t);
  const out = join(root, "open-env.json");
  fakeProgram(t, ["open", "xdg-open"], out);
  openInBrowser("http://127.0.0.1:4567/abcdefgh12345678/");
  assertNoPlanted(await waitFor(out));
});
