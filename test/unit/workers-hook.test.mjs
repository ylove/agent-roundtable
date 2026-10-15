// The PreToolUse lease hook, run through the built CLI exactly as Claude Code runs it: the hook
// JSON on stdin, the worker's identity in the environment, exit 2 plus a reason to deny.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRun, registerWorker, runner } from "../fixtures/workers/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../dist/index.js");
const { taskBranch } = await import("../../dist/execution/git.js");
const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const { writeAgentLeases } = await import("../../dist/workers/files.js");
const { ROUNDTABLE_HOME } = await import("../../dist/config.js");

let run;
let wt; // the worktree as WORKTREES_DIR spells it (on macOS, under the /var symlink)
let env;

async function grant(id, paths) {
  await run.store.transact(() => ({
    events: [{ type: "lease.granted", source: runner, payload: { lease: { id, agent: "builder-1", task: "api", paths, mode: "exclusive", branch: taskBranch(run.store.id, "api"), reason: "", granted_seq: 0 } } }],
  }));
  await writeAgentLeases(run.store, "builder-1");
}

before(async () => {
  run = await makeRun();
  await registerWorker(run.store, "builder-1", "api");
  await ensureTaskWorktree(run.header, "api");
  wt = join(ROUNDTABLE_HOME, "worktrees", run.store.id, "api");
  await grant("lease-1", ["src/api/**", "docs/**"]);
  env = { PATH: process.env.PATH, HOME: process.env.HOME, ROUNDTABLE_HOME, ROUNDTABLE_EXECUTION_ID: run.store.id, ROUNDTABLE_AGENT_ID: "builder-1" };
});

function hook(input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, "hook", "pre-tool-use"], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.trim() };
}

const call = (tool, file, key = "file_path") => ({
  session_id: "s", transcript_path: "/t", cwd: wt, permission_mode: "dontAsk", hook_event_name: "PreToolUse",
  tool_name: tool, tool_input: { [key]: file, old_string: "a", new_string: "b" }, tool_use_id: "toolu_1",
});

function denied(r, pattern) {
  assert.equal(r.code, 2, `expected a deny, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, pattern);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, r.stderr);
}

function allowed(r) {
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "", "an allow prints nothing (it must not bypass the permission rules)");
}

test("a leased path is allowed for Edit, Write, MultiEdit and NotebookEdit (absolute or relative)", () => {
  allowed(hook(call("Edit", join(wt, "src/api/index.js"))));
  allowed(hook(call("Write", join(wt, "src/api/new/deep/file.ts"))));
  allowed(hook(call("MultiEdit", join(wt, "docs/readme.md"))));
  allowed(hook(call("NotebookEdit", join(wt, "src/api/n.ipynb"), "notebook_path")));
  allowed(hook(call("Write", "src/api/relative.js")));
});

test("an unleased path is denied with the lease instruction", () => {
  denied(hook(call("Edit", join(wt, "src/components/nav/bar.js"))), /^No lease for src\/components\/nav\/bar\.js: call lease\(request\) or escalate\(with: path_owner\)$/);
  denied(hook(call("Write", join(wt, "README.md"))), /^No lease for README\.md:/);
});

test("outside the worktree, or with .., is denied", () => {
  denied(hook(call("Write", join(tmpdir(), "elsewhere.txt"))), /outside your task worktree/);
  denied(hook(call("Write", join(dirname(wt), "build-nav-bar", "x.js"))), /outside your task worktree/);
  denied(hook(call("Edit", `${wt}/src/api/../../README.md`)), /contains "\.\."/);
  denied(hook(call("Write", wt)), /worktree itself/);
});

test(".git at any depth and .gitmodules anywhere are denied, even when leased", async () => {
  await grant("lease-git", [".gitmodules", "src/api/.gitmodules", ".gitattributes"]);
  denied(hook(call("Write", join(wt, ".git"))), /inside a \.git directory/);
  denied(hook(call("Write", join(wt, "src/api/vendor/lib/.git/config"))), /inside a \.git directory/);
  denied(hook(call("Edit", join(wt, "src/api/.GIT/hooks/pre-commit"))), /inside a \.git directory/);
  denied(hook(call("Write", join(wt, ".gitmodules"))), /\.gitmodules\) is never writable/);
  denied(hook(call("Write", join(wt, "src/api/.gitmodules"))), /never writable/);
});

test(".gitattributes needs a lease that names it: ** is not enough", async () => {
  const fresh = await makeRun();
  await registerWorker(fresh.store, "builder-1", "api");
  await ensureTaskWorktree(fresh.header, "api");
  await fresh.store.transact(() => ({
    events: [{ type: "lease.granted", source: runner, payload: { lease: { id: "lease-all", agent: "builder-1", task: "api", paths: ["**"], mode: "exclusive", branch: taskBranch(fresh.store.id, "api"), reason: "", granted_seq: 0 } } }],
  }));
  await writeAgentLeases(fresh.store, "builder-1");
  const fwt = join(ROUNDTABLE_HOME, "worktrees", fresh.store.id, "api");
  const e = { ROUNDTABLE_EXECUTION_ID: fresh.store.id };
  allowed(hook({ ...call("Write", join(fwt, "anything/at/all.js")) }, e));
  denied(hook({ ...call("Write", join(fwt, ".gitattributes")) }, e), /^No lease for \.gitattributes/);
  denied(hook({ ...call("Write", join(fwt, ".github/workflows/ci.yml")) }, e), /^No lease for \.github\/workflows\/ci\.yml/);
  // The first run leased .gitattributes explicitly (previous test).
  allowed(hook(call("Write", join(wt, ".gitattributes"))));
});

test("secret-like files are denied whatever the leases", async () => {
  await grant("lease-secrets", ["**"]);
  for (const p of [".env", "src/api/.env.local", "src/api/server.pem", "src/api/tls.key", "src/api/id_rsa", "src/api/id_ed25519.pub", ".npmrc", "src/api/.netrc"]) {
    denied(hook(call("Write", join(wt, p))), /looks like a secret file/);
  }
  allowed(hook(call("Write", join(wt, "src/api/id_map.ts"))), "a source file named id_* is not a key");
  await run.store.transact(() => ({ events: [{ type: "lease.released", source: runner, payload: { lease_id: "lease-secrets" } }] }));
  await writeAgentLeases(run.store, "builder-1");
});

test("symlinks: a link that leads out is denied, a link as the target is denied, an in-tree link is judged by its target", () => {
  const outside = mkdtempSync(join(tmpdir(), "rt-hook-outside-"));
  mkdirSync(join(wt, "src/api/links"), { recursive: true });
  symlinkSync(outside, join(wt, "src/api/links/out"));
  denied(hook(call("Write", join(wt, "src/api/links/out/x.js"))), /outside your task worktree/);
  writeFileSync(join(wt, "src/api/real.js"), "x\n");
  symlinkSync(join(wt, "src/api/real.js"), join(wt, "src/api/links/file-link.js"));
  denied(hook(call("Edit", join(wt, "src/api/links/file-link.js"))), /is a symlink/);
  mkdirSync(join(wt, "src/components/nav"), { recursive: true });
  symlinkSync(join(wt, "src/components/nav"), join(wt, "src/api/links/nav"));
  denied(hook(call("Write", join(wt, "src/api/links/nav/bar.js"))), /^No lease for src\/components\/nav\/bar\.js/);
});

test("fails closed: other tools pass, bad input and a missing identity or leases file deny", () => {
  allowed(hook({ ...call("OtherTool", "/etc/passwd") }));
  denied(hook("not json"), /lease hook failed/);
  denied(hook({}), /could not read the tool call/);
  denied(hook(call("Write", join(wt, "src/api/a.js")), { ROUNDTABLE_AGENT_ID: "" }), /no ROUNDTABLE_EXECUTION_ID/);
  denied(hook(call("Write", join(wt, "src/api/a.js")), { ROUNDTABLE_AGENT_ID: "nobody" }), /no leases file/);
  denied(hook({ ...call("Write", join(wt, "src/api/a.js")), tool_input: {} }), /names no file path/);
});

test("the hook is fast", () => {
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) allowed(hook(call("Edit", join(wt, "src/api/index.js"))));
  const each = (Date.now() - t0) / 3;
  assert.ok(each < 1500, `${each} ms per hook call`);
});


test("tilde, URI and foreign paths are refused even beneath a broad lease", () => {
  for (const path of ["~/src/api/x.js", "~someone/x.js", "file:///etc/passwd", "C:\\outside.txt"]) {
    denied(hook(call("Write", path)), /relative or absolute path inside your worktree/);
  }
});

test("Read, Glob and Grep are confined and deny secrets without needing a lease", () => {
  allowed(hook(call("Read", "README.md")));
  for (const tool of ["Read", "Glob", "Grep"]) {
    const input = (path) => ({ ...call(tool, path, tool === "Read" ? "file_path" : "path"), tool_input: { [tool === "Read" ? "file_path" : "path"]: path, pattern: "**/*.js" } });
    denied(hook(input("/etc/passwd")), /outside your task worktree/);
    denied(hook(input("~/x")), /relative or absolute/);
    denied(hook(input("../x")), /contains "\.\."/);
    denied(hook(input("src/api/links/out")), /outside your task worktree|is a symlink/);
    for (const path of [".env", "src/api/tls.key", "src/api/id_ed25519.pub"]) denied(hook(input(path)), /secret file/);
    allowed(hook(input("src/components/nav")));
  }
  for (const pattern of ["../**", "src/{..,..}/**", "{src,/etc}/**", "~/**", "/etc/**", "C:\\**"]) denied(hook({ tool_name: "Glob", tool_input: { pattern } }), /relative pattern/);
  denied(hook({ tool_name: "Read", tool_input: {} }), /names no file path/);
});

test("recursive reads reject escaping symlinks and secret files in their subtree", () => {
  mkdirSync(join(wt, "docs/search"), { recursive: true });
  writeFileSync(join(wt, "docs/search/plain.txt"), "safe");
  allowed(hook({ tool_name: "Glob", tool_input: { path: "docs/search", pattern: "**/*" } }));
  allowed(hook({ tool_name: "Grep", tool_input: { path: "docs/search", pattern: "safe" } }));
  writeFileSync(join(wt, "docs/search/.env.local"), "secret");
  denied(hook({ tool_name: "Grep", tool_input: { path: "docs/search", pattern: ".*" } }), /secret file/);
  denied(hook({ tool_name: "Glob", tool_input: { pattern: "**/*" } }), /outside your task worktree|secret file|symlink/);
});
