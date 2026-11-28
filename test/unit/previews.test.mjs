import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { SecureServer } from "../../dist/http/secure-server.js";
import { inlineProblems } from "./helpers.mjs";
import { startInput, previewTools } from "../../dist/tools/previews.js";
import { PROTOTYPE_DIR, WORKTREES_DIR } from "../../dist/config.js";
import { buildForwarderCreateArgs, buildForwarderNetworkCreateArgs, forwarderNetworkName, buildInstallRunArgs, buildNetworkCreateArgs, buildPreviewRunArgs, forwarderName, previewContainerName, previewNetworkName } from "../../dist/previews/args.js";
import { defaultPort, parsePackageJson, pickScript, previewArgv, validatePort, viteHostFlag } from "../../dist/previews/scripts.js";
import { ORIGIN_RE, parseRecord, previewsDir, readRecords, readPreviewScreenshot, writePreviewScreenshot, writeRecord } from "../../dist/previews/store.js";
import { livePreviews, previewFramesHtml, previewOrigins, withFrameSrc } from "../../dist/previews/embed.js";
import { defaultDeps, createPreviewNetwork, parsePublishedPort, previewCliStarter, previewDisplay, previewSettings, refreshPreviews, resolveSource, startPreview, stopAllPreviews, stopExecutionPreviews, stopPreview, sweepPreviews } from "../../dist/previews/manager.js";
import { parsePreviewArgs } from "../../dist/cli-preview.js";
import { renderIndex, INDEX_CSP } from "../../dist/serve/index.js";
import { DASHBOARD_CSP } from "../../dist/dashboard/server.js";
import { ROOM_CSP } from "../../dist/table/room-assets.js";
import { hostname } from "node:os";
import { duelPreviewsOf, startRoom } from "../../dist/table/room.js";

const limits = { memory: "2g", cpus: "2", pids: 512 };
const ID = "prv-0123456z";
const EXE = "exe-0123456789abcdef";

// Exercise the real HTTP dispatcher in memory, without opening a listener.
async function roomHarness(t) {
  let server;
  t.mock.method(SecureServer, "start", async opts => {
    server = new SecureServer(opts, { close(done) { done?.(); }, closeAllConnections() {} });
    server.port = 23456;
    return server;
  });
  const room = await startRoom({ open: false, hold: false });
  t.after(() => room.close());
  return { room, fetch: async url => {
    const req = Readable.from([]);
    req.url = new URL(url).pathname;
    req.method = "GET";
    req.headers = { host: "127.0.0.1:23456" };
    let status, headers, body;
    await server.route(req, { writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; }, destroy() {} });
    return new Response(body, { status, headers });
  } };
}

// ---- scripts -------------------------------------------------------------

test("script selection: dev, then start, then preview; only known names that the package defines", () => {
  assert.equal(pickScript({ scripts: { start: "node a", dev: "vite" } }), "dev");
  assert.equal(pickScript({ scripts: { start: "node a", preview: "x" } }), "start");
  assert.equal(pickScript({ scripts: { preview: "x" } }), "preview");
  assert.equal(pickScript({ scripts: { dev: "a", start: "b" } }, "start"), "start");
  assert.throws(() => pickScript({ scripts: { build: "x" } }), /none of the scripts/);
  assert.throws(() => pickScript({ scripts: { dev: "a" } }, "start"), /no "start" script/);
  for (const bad of ["build", "dev; rm -rf /", "npm run dev", "", 7]) assert.throws(() => pickScript({ scripts: { dev: "a", build: "b" } }, bad), /one of the package scripts/);
  assert.throws(() => pickScript({ scripts: { dev: "   " } }), /none of the scripts/);
  assert.deepEqual(previewArgv("dev"), ["npm", "run", "dev"]);
  assert.throws(() => parsePackageJson("{nope"), /not valid JSON/);
  assert.throws(() => parsePackageJson("[]"), /not an object/);
});

test("ports: the spec's, else the dev server's usual, else 3000; privileged and out-of-range ports are refused", () => {
  assert.equal(defaultPort({ devDependencies: { vite: "^5" } }), 5173);
  assert.equal(defaultPort({ dependencies: { next: "14" } }), 3000);
  assert.equal(defaultPort({ devDependencies: { astro: "4" } }), 4321);
  assert.equal(defaultPort({}), 3000);
  assert.equal(defaultPort({ devDependencies: { vite: "5" } }, 8080), 8080);
  for (const bad of [80, 1023, 65536, 3000.5, "3000", NaN, null]) assert.throws(() => validatePort(bad), /port must be/);
});

// ---- docker argv ---------------------------------------------------------

const runOpts = { id: ID, uid: 1000, gid: 1000, image: "node:22-bookworm-slim", limits, script: "dev", port: 5173 };

test("preview run argv: internal network only, nothing published, hardened, labelled, no host mount", () => {
  const args = buildPreviewRunArgs({ ...runOpts, labels: { execution: EXE, task: "t1" } });
  const text = args.join(" ");
  assert.ok(!args.includes("-p") && !args.includes("--publish") && !args.includes("-P"), "the server publishes nothing itself");
  assert.doesNotMatch(text, /0\.0\.0\.0:|:0\.0\.0\.0/);
  assert.doesNotMatch(text, /--network host|--net host|--network=host|--pid host|--privileged|--cap-add/);
  assert.equal(args[args.indexOf("--network") + 1], "rt-pvnet-0123456z", "the preview's own internal network");
  assert.equal(args[args.indexOf("--network-alias") + 1], "app");
  assert.ok(args.includes("--read-only"));
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "512");
  assert.equal(args[args.indexOf("--memory") + 1], "2g");
  assert.equal(args[args.indexOf("--memory-swap") + 1], "2g");
  assert.equal(args[args.indexOf("--cpus") + 1], "2");
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.equal(args[args.indexOf("--log-driver") + 1], "none");
  assert.ok(text.includes(`--label roundtable.preview=${ID}`));
  assert.ok(text.includes(`--label roundtable.preview-execution=${EXE}`));
  assert.ok(text.includes("--label roundtable.preview-task=t1"));
  // The source never reaches the container as a mount: no bind, no volume, only tmpfs.
  assert.ok(!args.includes("--mount") && !args.includes("-v") && !args.includes("--volume"));
  assert.ok(args.some(a => /^\/app:rw,nosuid,nodev,size=\w+,uid=1000,gid=1000/.test(a)));
  assert.ok(args.includes("-i"), "the snapshot arrives on stdin");
  assert.equal(args.at(-7), "sh");
  assert.equal(args.at(-6), "-c");
  assert.equal(args.at(-5), 'tar -xf - -C /app && exec "$@"', "a fixed unpack-then-exec text; nothing is interpolated");
  assert.deepEqual(args.slice(-4), ["sh", "npm", "run", "dev"]);
  assert.ok(args.includes("PORT=5173"));
  assert.equal(previewContainerName(ID), "rt-preview-0123456z");
  assert.equal(forwarderName(ID), "rt-preview-0123456z-fwd");
  assert.equal(previewNetworkName(ID), "rt-pvnet-0123456z");
});

test("host flag: only the fixed pair after --, only when asked; a duel label is a safe token", () => {
  const plain = buildPreviewRunArgs(runOpts);
  assert.ok(!plain.includes("--"), "no pass-through by default");
  const flagged = buildPreviewRunArgs({ ...runOpts, hostFlag: true });
  assert.deepEqual(flagged.slice(-6), ["npm", "run", "dev", "--", "--host", "0.0.0.0"]);
  const duel = buildPreviewRunArgs({ ...runOpts, labels: { prototype: "P1v1", duel: "duel-1234" } });
  assert.ok(duel.join(" ").includes("--label roundtable.preview-duel=duel-1234"));
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, labels: { duel: "x; rm -rf /" } }), /invalid duel label/);
});

test("vite detection: a plain vite script gets --host; --host already there or another tool needs nothing; a composite vite script is refused", () => {
  const pkg = (dev) => ({ scripts: { dev } });
  assert.equal(viteHostFlag(pkg("vite"), "dev"), true);
  assert.equal(viteHostFlag(pkg("vite --port 4000"), "dev"), true);
  assert.equal(viteHostFlag(pkg("npx vite preview"), "dev"), true);
  assert.equal(viteHostFlag(pkg("vite --host"), "dev"), false);
  assert.equal(viteHostFlag(pkg("vite --host 0.0.0.0 --port 80"), "dev"), false);
  assert.equal(viteHostFlag(pkg("vite --host=0.0.0.0"), "dev"), false);
  assert.equal(viteHostFlag(pkg("next dev"), "dev"), false);
  assert.equal(viteHostFlag(pkg("node server.js"), "dev"), false);
  assert.equal(viteHostFlag(pkg("devite --x"), "dev"), false);
  assert.equal(viteHostFlag({}, "dev"), false);
  for (const bad of ["vite && echo hi", "tsc -w & vite", "vite; rm -rf x", "vite $(id)", "vite `id`", "cross-env A=1 vite"]) {
    assert.throws(() => viteHostFlag(pkg(bad), "dev"), /runs vite without --host.*Add --host to the script/, bad);
  }
});

test("forwarder argv: the one published port is 127.0.0.1 only; the network is internal", () => {
  const args = buildForwarderCreateArgs({ id: ID, uid: 1000, gid: 1000, image: "node:22-bookworm-slim", limits, port: 5173 });
  const text = args.join(" ");
  assert.equal(args[0], "create");
  assert.equal(args[args.indexOf("-p") + 1], "127.0.0.1::5173");
  assert.equal(args.filter(a => a === "-p" || a === "--publish").length, 1);
  assert.doesNotMatch(text, /0\.0\.0\.0:\d|:0\.0\.0\.0|--network host|--net host|--network=host|--privileged|--cap-add|--mount|--volume| -v /);
  assert.ok(args.includes("--read-only"));
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.equal(args[args.indexOf("--memory") + 1], "128m");
  assert.ok(text.includes(`--label roundtable.preview=${ID}`));
  assert.deepEqual(buildNetworkCreateArgs(ID), ["network", "create", "--internal", "--label", `roundtable.preview-net=${ID}`, "rt-pvnet-0123456z"]);
  // The forwarder has a network of its own (not the shared default bridge), labelled like the internal one.
  assert.equal(args[args.indexOf("--network") + 1], "rt-pvfwd-0123456z");
  assert.equal(forwarderNetworkName(ID), "rt-pvfwd-0123456z");
  assert.ok(!args.includes("bridge") && !args.includes("host"));
  assert.deepEqual(buildForwarderNetworkCreateArgs(ID), ["network", "create", "--label", `roundtable.preview-net=${ID}`, "rt-pvfwd-0123456z"]);
  assert.throws(() => buildForwarderCreateArgs({ id: ID, uid: 0, gid: 0, image: "node", limits, port: 5173 }), /never runs as root/);
  assert.throws(() => buildForwarderCreateArgs({ id: ID, uid: 1, gid: 1, image: "node", limits, port: 22 }), /port must be/);
});

test("preview run argv: refuses root, bad ids, bad images, bad ports, bad labels and unknown scripts' shells", () => {
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, uid: 0 }), /never runs as root/);
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, id: "prv-../x" }), /invalid preview id/);
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, image: "bad image;rm" }), /invalid image/);
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, port: 80 }), /port must be/);
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, labels: { task: "a b" } }), /invalid task label/);
  assert.throws(() => buildPreviewRunArgs({ ...runOpts, limits: { ...limits, memory: "lots" } }), /resource limits/);
});

test("install argv: egress network only, lifecycle scripts off, nothing published, no host mount", () => {
  const args = buildInstallRunArgs({ ...runOpts, network: "rt-egress-x-1", proxyUrl: "http://rt-proxy-x-1:3128", command: "ci" });
  const text = args.join(" ");
  assert.equal(args[args.indexOf("--network") + 1], "rt-egress-x-1");
  assert.ok(text.includes("--ignore-scripts"));
  assert.ok(!args.includes("-p") && !args.includes("--publish") && !args.includes("--mount"));
  assert.ok(args.includes("--read-only") && args.includes("--cap-drop"));
  assert.ok(args.includes("HTTPS_PROXY=http://rt-proxy-x-1:3128"));
  assert.equal(args.at(-1), "ci");
  assert.throws(() => buildInstallRunArgs({ ...runOpts, network: "n", proxyUrl: "p", command: "exec" }), /ci or install/);
});

test("published port parsing accepts only a 127.0.0.1 binding", () => {
  assert.equal(parsePublishedPort("127.0.0.1:49153\n"), 49153);
  assert.equal(parsePublishedPort("0.0.0.0:49153\n[::]:49153"), undefined);
  assert.equal(parsePublishedPort("[::1]:5000"), undefined);
  assert.equal(parsePublishedPort(""), undefined);
});

// ---- settings ------------------------------------------------------------

test("settings: defaults and environment overrides; bad values fall back", t => {
  t.mock.method(console, "error", () => {});
  const d = previewSettings({});
  assert.deepEqual(d, { ttlMs: 30 * 60_000, maxPreviews: 3, readyTimeoutMs: 120_000 });
  const o = previewSettings({ ROUNDTABLE_PREVIEW_TTL_MIN: "5", ROUNDTABLE_PREVIEW_MAX: "1", ROUNDTABLE_PREVIEW_READY_TIMEOUT_SEC: "10" });
  assert.deepEqual(o, { ttlMs: 300_000, maxPreviews: 1, readyTimeoutMs: 10_000 });
  assert.equal(previewSettings({ ROUNDTABLE_PREVIEW_MAX: "0" }).maxPreviews, 3);
  assert.equal(previewSettings({ ROUNDTABLE_PREVIEW_TTL_MIN: "soon" }).ttlMs, 30 * 60_000);
});

test("display defaults by starter, with explicit option then environment precedence", t => {
  t.mock.method(console, "error", () => {});
  const settings = previewSettings({});
  const tty = { stdin: true, stdout: true };
  assert.equal(previewDisplay({ starter: previewCliStarter({}, tty) }, settings), "live", "interactive terminal");
  assert.equal(previewDisplay({ starter: previewCliStarter({}, { stdin: false, stdout: true }) }, settings), "click", "piped stdin");
  assert.equal(previewDisplay({ starter: previewCliStarter({}, { stdin: true, stdout: false }) }, settings), "click", "piped stdout");
  assert.equal(previewDisplay({ starter: previewCliStarter({}, {}) }, settings), "click", "no terminal");
  for (const env of [{ ROUNDTABLE_EXECUTION_ID: EXE }, { ROUNDTABLE_AGENT_ID: "builder" }]) {
    assert.equal(previewDisplay({ starter: previewCliStarter(env, tty) }, settings), "click", "agent marker beats a terminal");
  }
  assert.equal(previewDisplay({}, settings), "click", "MCP and execution starts default to click");
  for (const display of ["live", "click", "screenshot"]) {
    const configured = previewSettings({ ROUNDTABLE_PREVIEW_DISPLAY: display });
    for (const starter of ["cli", "agent"]) {
      assert.equal(previewDisplay({ starter }, configured), display);
      assert.equal(previewDisplay({ starter, display: "screenshot" }, configured), "screenshot");
    }
    assert.equal(parsePreviewArgs(["start", "--prototype", "/p", "--display", display]).input.display, display);
    assert.equal(previewDisplay(startInput({ prototype: "/p", display }), settings), display);
  }
  assert.equal(previewDisplay({}, previewSettings({ ROUNDTABLE_PREVIEW_DISPLAY: "unknown" })), "click");
  for (const display of ["unknown", "", false, 1]) {
    assert.throws(() => previewDisplay(startInput({ display }), settings), /display must be/);
  }
  assert.throws(() => parsePreviewArgs(["start", "--prototype", "/p", "--display", "unknown"]), /--display/);
  assert.deepEqual(previewTools.find(t => t.name === "start_preview").inputSchema.properties.display.enum, ["live", "click", "screenshot"]);
});

// ---- sources -------------------------------------------------------------

function prototypeDir(name, pkg = { scripts: { dev: "node server.js" } }, modules = true) {
  mkdirSync(PROTOTYPE_DIR, { recursive: true });
  const dir = mkdtempSync(join(PROTOTYPE_DIR, `${name}-`));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  if (modules) { mkdirSync(join(dir, "node_modules")); writeFileSync(join(dir, "node_modules", "x.js"), "1"); }
  return dir;
}

test("sources: a task worktree or a prototype under the root; paths outside or symlinked are refused", () => {
  const dir = prototypeDir("P1v1");
  const r = resolveSource({ prototype: dir });
  assert.equal(r.source.kind, "prototype");
  assert.match(r.source.prototype, /^[A-Za-z0-9._-]+$/);
  assert.throws(() => resolveSource({ prototype: tmpOutside() }), /inside the prototype root/);
  assert.throws(() => resolveSource({ prototype: "relative/dir" }), /absolute/);
  assert.throws(() => resolveSource({ prototype: PROTOTYPE_DIR }), /inside the prototype root/);
  assert.throws(() => resolveSource({}), /either execution and task, or prototype/);
  assert.throws(() => resolveSource({ prototype: dir, execution: EXE, task: "t1" }), /either execution and task, or prototype/);
  assert.throws(() => resolveSource({ execution: "nope", task: "t1" }), /exe-/);
  assert.throws(() => resolveSource({ execution: EXE, task: "../x" }), /task id/);
  assert.throws(() => resolveSource({ execution: EXE, task: "missing1" }), /does not exist/);
  mkdirSync(join(WORKTREES_DIR, EXE, "t1"), { recursive: true });
  assert.deepEqual(resolveSource({ execution: EXE, task: "t1" }).source, { kind: "task", execution: EXE, task: "t1" });
});

function tmpOutside() {
  return mkdtempSync(join(PROTOTYPE_DIR, "..", "outside-"));
}

// ---- lifecycle with a fake docker ---------------------------------------

function fakeDocker(opts = {}) {
  const calls = [];
  const containers = new Map(); // name -> preview id
  const networks = new Set();
  let nextPort = 41000;
  return {
    calls, containers, networks,
    async info() { return opts.down ? { ok: false, reason: "Cannot connect to the Docker daemon" } : { ok: true }; },
    async quiet(args) {
      calls.push(args);
      switch (args[0]) {
        case "network":
          if (args[1] === "create") networks.add(args.at(-1));
          if (args[1] === "rm") networks.delete(args[2]);
          if (args[1] === "ls") return { ok: true, output: [...networks].map(n => `${n} prv-${n.slice(9)}`).join("\n") };
          return { ok: true, output: "" };
        case "create": {
          const name = args[args.indexOf("--name") + 1];
          containers.set(name, args.find(a => a.startsWith("roundtable.preview=")).slice("roundtable.preview=".length));
          return { ok: true, output: "id" };
        }
        case "port": return containers.has(args[1]) && !opts.noPort ? { ok: true, output: `127.0.0.1:${opts.port ?? ++nextPort}\n` } : { ok: false, output: "no such container" };
        case "rm": for (const n of args.slice(2)) containers.delete(n); return { ok: true, output: "" };
        case "ps": return { ok: !opts.psFails, output: [...containers].map(([n, id]) => `${n} ${id} running`).join("\n") };
        default: return { ok: true, output: "" };
      }
    },
    start(args, stdinFile) {
      calls.push(["start-client", ...args]);
      const name = args[args.indexOf("--name") + 1];
      containers.set(name, args.find(a => a.startsWith("roundtable.preview=")).slice("roundtable.preview=".length));
      calls.start = { args, stdinFile };
      return { exited: opts.exits ? Promise.resolve({ code: 1, tail: "npm ERR! missing script" }) : new Promise(() => {}), detach() { calls.detached = true; } };
    },
    async runToFile(args, stdin, stdout) {
      calls.push(["install", ...args]);
      writeFileSync(stdout, "installed");
      return opts.installFails ? { ok: false, code: 1, tooBig: false, timedOut: false, tail: "E404 registry" } : { ok: true, code: 0, tooBig: false, timedOut: false, tail: "" };
    },
  };
}

function makeDeps(docker, extra = {}) {
  const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
  const deps = {
    ...defaultDeps({}),
    docker,
    user: { uid: 1000, gid: 1000 },
    now: () => clock.t,
    sleep: async ms => { clock.t += ms; },
    probe: async () => true,
    pageCheck: async () => ({ loaded: true, consoleErrors: [], exceptions: [], failedRequests: 0 }),
    ensureImage: async () => ({ ok: true }),
    egress: async () => ({ network: "rt-egress-t-1", proxyUrl: "http://rt-proxy-t-1:3128", teardown: async () => { docker.calls.push(["teardown"]); } }),
    snapshot: async (_dir, out, modules) => { writeFileSync(out, `tar modules=${modules}`); },
    ownerGone: async () => false,
    ...extra,
  };
  return { deps, clock };
}

async function clean() {
  const { stopAllPreviews: _ } = await import("../../dist/previews/manager.js");
  await stopAllPreviews({ docker: fakeDocker() });
}

test("start records the chosen display and keeps page-check PNGs separate from metadata", async () => {
  await clean();
  const docker = fakeDocker();
  const png = Buffer.from("page-check PNG");
  const { deps } = makeDeps(docker, { pageCheck: async () => ({ loaded: true, consoleErrors: [], exceptions: [], failedRequests: 0, screenshot: png }) });
  for (const [input, settings, expected] of [
    [{}, {}, "click"], [{ starter: "agent" }, {}, "click"], [{ starter: "cli" }, {}, "live"],
    [{ starter: "cli" }, { display: "click" }, "click"], [{ display: "screenshot" }, { display: "live" }, "screenshot"],
    [{ display: "live" }, { display: "screenshot" }, "live"],
  ]) {
    const r = await startPreview({ prototype: prototypeDir("display"), ...input }, { ...deps, settings: { ...deps.settings, ...settings } });
    assert.equal(r.display, expected);
    assert.equal(readRecords().find(x => x.id === r.id).display, expected);
    assert.equal(r.check.screenshot, undefined);
    assert.deepEqual(readPreviewScreenshot(r.id), png);
    await stopPreview(r.id, { docker });
    assert.equal(readPreviewScreenshot(r.id), undefined);
  }
  await assert.rejects(startPreview({ display: "unknown" }, deps), /display must be/);
});

test("start: snapshot, port read-back on loopback, readiness, page check, record, no network install when node_modules exist", async () => {
  await clean();
  const dir = prototypeDir("P2v1");
  const docker = fakeDocker({ port: 43210 });
  const { deps } = makeDeps(docker);
  const r = await startPreview({ prototype: dir }, deps);
  assert.match(r.id, /^prv-[0-9a-hjkmnp-tv-z]{8}$/);
  assert.equal(r.origin, "http://127.0.0.1:43210");
  assert.ok(ORIGIN_RE.test(r.origin));
  assert.equal(r.script, "dev");
  assert.equal(r.container_port, 3000);
  assert.equal(r.check.loaded, true);
  assert.ok(!docker.calls.some(c => c[0] === "install"), "no install when node_modules are present");
  assert.ok(docker.calls.some(c => c[0] === "network" && c[1] === "create" && c.includes("--internal")));
  assert.ok(docker.calls.some(c => c[0] === "network" && c[1] === "connect" && c[2] === previewNetworkName(r.id) && c[3] === forwarderName(r.id)));
  const forwarder = docker.calls.find(c => c[0] === "create");
  assert.equal(forwarder[forwarder.indexOf("-p") + 1], "127.0.0.1::3000");
  assert.ok(docker.calls.some(c => c[0] === "port" && c[1] === forwarderName(r.id) && c[2] === "3000/tcp"));
  assert.equal(docker.calls.detached, true);
  assert.deepEqual(readRecords().map(x => x.id), [r.id]);
  assert.ok(!readdirSync(previewsDir()).some(n => n.startsWith("tmp-")), "the work directory is removed");
  assert.equal(await stopPreview(r.id, { docker }), true);
  assert.deepEqual(readRecords(), []);
  assert.ok(docker.calls.some(c => c[0] === "rm" && c.includes(r.container) && c.includes(forwarderName(r.id))));
  assert.equal(docker.networks.size, 0, "the internal network is removed with the preview");
  assert.equal(await stopPreview(r.id, { docker }), false);
});

test("start without node_modules installs in a container behind the egress proxy, then tears the proxy down", async () => {
  await clean();
  const dir = prototypeDir("P3v1", { scripts: { dev: "vite" }, devDependencies: { vite: "5" } }, false);
  writeFileSync(join(dir, "package-lock.json"), "{}");
  const docker = fakeDocker();
  const { deps } = makeDeps(docker);
  let allowed;
  deps.egress = async () => { allowed = "registry.npmjs.org"; return { network: "rt-egress-t-1", proxyUrl: "http://rt-proxy-t-1:3128", teardown: async () => docker.calls.push(["teardown"]) }; };
  const r = await startPreview({ prototype: dir }, deps);
  assert.equal(r.container_port, 5173);
  const install = docker.calls.find(c => c[0] === "install");
  assert.ok(install.includes("rt-egress-t-1") && install.at(-1) === "ci" && install.join(" ").includes("--ignore-scripts"));
  assert.equal(allowed, "registry.npmjs.org");
  assert.ok(docker.calls.some(c => c[0] === "teardown"));
  const run = docker.calls.find(c => c[0] === "start-client");
  assert.equal(run[run.indexOf("--network") + 1], previewNetworkName(r.id), "the server container never gets the egress network");
  await stopAllPreviews({ docker });
});

test("start: a failed install, a missing daemon, an early exit and a readiness timeout are clear errors and leave nothing behind", async () => {
  await clean();
  const dir = prototypeDir("P4v1", { scripts: { dev: "x" } }, false);
  let docker = fakeDocker({ installFails: true });
  await assert.rejects(startPreview({ prototype: dir }, makeDeps(docker).deps), /dependency install failed: npm exited 1: E404/);
  assert.ok(docker.calls.some(c => c[0] === "teardown"));
  assert.deepEqual(readRecords(), []);

  docker = fakeDocker({ down: true });
  await assert.rejects(startPreview({ prototype: dir }, makeDeps(docker).deps), /Docker is not available \(Cannot connect to the Docker daemon\)/);

  const ready = prototypeDir("P4v2");
  docker = fakeDocker({ exits: true, noPort: true });
  await assert.rejects(startPreview({ prototype: ready }, makeDeps(docker).deps), /container exited \(1\): npm ERR! missing script/);
  assert.equal(docker.containers.size, 0, "the containers are removed");
  assert.equal(docker.networks.size, 0, "and the network");

  docker = fakeDocker();
  const { deps, clock } = makeDeps(docker, { probe: async () => false });
  deps.settings = { ...deps.settings, readyTimeoutMs: 5_000 };
  const before = clock.t;
  await assert.rejects(startPreview({ prototype: ready }, deps), /did not answer on port 3000 within 5s/);
  assert.ok(clock.t - before >= 5_000);
  assert.equal(docker.containers.size, 0);
  assert.deepEqual(readRecords(), []);
});

test("start: the cap on concurrent previews", async () => {
  await clean();
  const docker = fakeDocker();
  const { deps } = makeDeps(docker);
  deps.settings = { ...deps.settings, maxPreviews: 2 };
  const a = await startPreview({ prototype: prototypeDir("P5a") }, deps);
  await startPreview({ prototype: prototypeDir("P5b") }, deps);
  await assert.rejects(startPreview({ prototype: prototypeDir("P5c") }, deps), /2 previews are already running/);
  await stopPreview(a.id, { docker });
  const c = await startPreview({ prototype: prototypeDir("P5d") }, deps);
  assert.ok(c.id);
  await stopAllPreviews({ docker });
  assert.deepEqual(readRecords(), []);
});

test("sweep: idle TTL, ended runs, records without containers and containers without records", async () => {
  await clean();
  const docker = fakeDocker();
  const { deps, clock } = makeDeps(docker);
  const a = await startPreview({ prototype: prototypeDir("P6a") }, deps);
  const b = await startPreview({ prototype: prototypeDir("P6b") }, deps);
  let r = await sweepPreviews(deps);
  assert.deepEqual([r.expired, r.ownerGone, r.orphanRecords, r.orphanContainers], [[], [], [], []]);

  // Viewing restarts the idle time.
  clock.t += 20 * 60_000;
  await refreshPreviews(deps);
  clock.t += 20 * 60_000;
  assert.deepEqual((await sweepPreviews(deps)).expired, [], "20 idle minutes since the last use is inside the 30 minute TTL");
  clock.t += 11 * 60_000;
  r = await sweepPreviews(deps);
  assert.deepEqual(r.expired.sort(), [a.id, b.id].sort());
  assert.deepEqual(readRecords(), []);

  // A run that ended.
  const c = await startPreview({ prototype: prototypeDir("P6c") }, deps);
  deps.ownerGone = async rec => rec.id === c.id;
  r = await sweepPreviews(deps);
  assert.deepEqual(r.ownerGone, [c.id]);
  assert.equal(docker.containers.size, 0);
  deps.ownerGone = async () => false;

  // A record whose container vanished, and a labelled container nobody records.
  const d = await startPreview({ prototype: prototypeDir("P6d") }, deps);
  docker.containers.delete(d.container);
  docker.containers.set("rt-preview-zzzzzzzz", "prv-zzzzzzzz");
  docker.containers.set("rt-preview-zzzzzzzz-fwd", "prv-zzzzzzzz");
  docker.networks.add("rt-pvnet-qqqqqqqq");
  r = await sweepPreviews(deps);
  assert.deepEqual(r.orphanRecords, [d.id]);
  assert.deepEqual(r.orphanContainers.sort(), ["rt-preview-zzzzzzzz", "rt-preview-zzzzzzzz-fwd"]);
  assert.ok(!docker.networks.has("rt-pvnet-qqqqqqqq"), "a network with nothing behind it is removed");
});

test("sweep leaves everything alone when Docker cannot be listed, and spares containers of a start in progress", async () => {
  await clean();
  const docker = fakeDocker();
  const { deps } = makeDeps(docker);
  const a = await startPreview({ prototype: prototypeDir("P7a") }, deps);
  docker.opts = { psFails: true };
  const failing = fakeDocker({ psFails: true });
  failing.containers = docker.containers;
  assert.deepEqual((await sweepPreviews({ ...deps, docker: failing })).expired, []);
  assert.equal(readRecords().length, 1);

  docker.containers.set("rt-preview-yyyyyyyy", "prv-yyyyyyyy");
  mkdirSync(join(previewsDir(), "tmp-inprogress"), { recursive: true });
  let r = await sweepPreviews(deps);
  assert.deepEqual(r.orphanContainers, [], "a fresh work directory means a start is running");
  const old = (deps.now() - 3600_000) / 1000;
  utimesSync(join(previewsDir(), "tmp-inprogress"), old, old);
  r = await sweepPreviews(deps);
  assert.deepEqual(r.orphanContainers, ["rt-preview-yyyyyyyy"]);
  assert.ok(!existsSync(join(previewsDir(), "tmp-inprogress")), "a stale work directory is removed");
  await stopPreview(a.id, { docker });
});

test("records: only exactly-shaped files are trusted", async () => {
  await clean();
  const good = { id: ID, container: "rt-preview-0123456z", origin: "http://127.0.0.1:4000", host_port: 4000, container_port: 3000, script: "dev",
    source: { kind: "prototype", prototype: "P1" }, started_at: "2026-01-01T00:00:00Z", last_seen: "2026-01-01T00:00:00Z", ttl_ms: 1000, host: hostname() };
  assert.ok(parseRecord(good));
  assert.equal(parseRecord(good).display, "live", "legacy records retain their display");
  for (const display of ["live", "click", "screenshot"]) assert.equal(parseRecord({ ...good, display }).display, display);
  for (const display of ["unknown", null, false, 1]) assert.equal(parseRecord({ ...good, display }), undefined);
  for (const bad of [{ ...good, origin: "http://0.0.0.0:4000" }, { ...good, origin: "http://127.0.0.1:4000/x" }, { ...good, origin: "https://127.0.0.1:4000" },
    { ...good, origin: "http://127.0.0.1:4000 http://evil.example" }, { ...good, host_port: 4001 }, { ...good, id: "prv-x" }, { ...good, container: "evil" }, { ...good, source: { kind: "x" } }, null, "x"]) {
    assert.equal(parseRecord(bad), undefined);
  }
  writeRecord(good);
  assert.equal(readRecords().length, 1);
  writeFileSync(join(previewsDir(), "prv-9999999z.json"), "{not json");
  assert.equal(readRecords().length, 1);
  assert.equal(livePreviews(r => r.id === "other").length, 0);
});

test("the runner hook stops only that run's previews; the sweep removes both networks of a stray", async () => {
  await clean();
  const docker = fakeDocker();
  const { deps } = makeDeps(docker);
  const other = await startPreview({ prototype: prototypeDir("P7a") }, deps);
  assert.equal(await stopExecutionPreviews(EXE, { docker }), 0, "nothing to stop");
  assert.ok(!docker.calls.some(c => c[0] === "rm" && c.includes(other.container)));
  writeRecord(record({ id: "prv-0000000z", container: "rt-preview-0000000z", host_port: 4001, origin: "http://127.0.0.1:4001" }));
  docker.containers.set("rt-preview-0000000z", "prv-0000000z");
  docker.networks.add("rt-pvnet-0000000z").add("rt-pvfwd-0000000z");
  assert.equal(await stopExecutionPreviews(EXE, { docker }), 1);
  assert.deepEqual(readRecords().map(x => x.id), [other.id], "another preview is untouched");
  assert.ok(!docker.networks.has("rt-pvnet-0000000z") && !docker.networks.has("rt-pvfwd-0000000z"));
  assert.ok(docker.networks.has(previewNetworkName(other.id)) && docker.networks.has(forwarderNetworkName(other.id)));
  docker.networks.add("rt-pvfwd-qqqqqqqq");
  await sweepPreviews(deps);
  assert.ok(!docker.networks.has("rt-pvfwd-qqqqqqqq"), "a forwarder network with nothing behind it is removed");
  assert.equal(await stopExecutionPreviews(EXE, { docker: { quiet: async () => { throw new Error("down"); } } }), 0);
  await clean();
});

test("start: a vite script gets --host through the script; the server is refused when it cannot be told", async () => {
  await clean();
  const docker = fakeDocker();
  const { deps } = makeDeps(docker);
  const r = await startPreview({ prototype: prototypeDir("P8a", { scripts: { dev: "vite" }, devDependencies: { vite: "5" } }) }, deps);
  const run = docker.calls.find(c => c[0] === "start-client");
  assert.deepEqual(run.slice(-6), ["npm", "run", "dev", "--", "--host", "0.0.0.0"]);
  await stopPreview(r.id, { docker });
  const before = docker.calls.length;
  await assert.rejects(startPreview({ prototype: prototypeDir("P8b", { scripts: { dev: "vite && echo" } }) }, deps), /Add --host to the script/);
  assert.equal(docker.calls.length, before, "refused before Docker is touched");
});

test("duel previews carry the duel id: the source, and the room shows only the current duel's", async t => {
  await clean();
  const duelId = "duel-12345678-aaaa-bbbb-cccc-1234567890ab";
  const session = mkdtempSync(join(PROTOTYPE_DIR, `${duelId.slice(0, 40)}-`));
  mkdirSync(join(session, "submission-1"));
  writeFileSync(join(session, "submission-1", "package.json"), JSON.stringify({ scripts: { dev: "node s.js" } }));
  const src = resolveSource({ prototype: join(session, "submission-1") }).source;
  assert.equal(src.duel, duelId.slice(0, 40));
  assert.equal(resolveSource({ prototype: prototypeDir("P1v1") }).source.duel, undefined);
  assert.equal(parseRecord(record({ source: { ...src } })) !== undefined, true);
  assert.equal(parseRecord(record({ source: { kind: "prototype", duel: "../x" } })), undefined);
  // Filtering: none before a duel starts, only the matching duel afterwards.
  const mine = record({ id: "prv-0000000a", source: { kind: "prototype", prototype: "p", duel: duelId.slice(0, 40) } });
  const theirs = record({ id: "prv-0000000b", source: { kind: "prototype", prototype: "q", duel: "duel-other" } });
  const none = record({ id: "prv-0000000c", source: { kind: "prototype", prototype: "r" } });
  assert.deepEqual(duelPreviewsOf(undefined, [mine]), []);
  assert.deepEqual(duelPreviewsOf(duelId, [mine, theirs, none]).map(x => x.id), ["prv-0000000a"]);
  // The room: previews.json and the CSP follow the duel that is running.
  const { room, fetch } = await roomHarness(t);
  t.after(async () => { await room.close(); await clean(); });
  const base = new URL(room.url);
  writeRecord({ ...mine, id: "prv-0000000a", container: "rt-preview-0000000a", host_port: 4010, origin: "http://127.0.0.1:4010" });
  writeRecord({ ...theirs, id: "prv-0000000b", container: "rt-preview-0000000b", host_port: 4011, origin: "http://127.0.0.1:4011" });
  assert.deepEqual(await (await fetch(new URL("previews.json", base))).json(), [], "no duel yet");
  await room.observer.onEvent({ type: "start", id: duelId, topic: "t", mode: "duel", seats: [], startedAt: new Date().toISOString() });
  const list = await (await fetch(new URL("previews.json", base))).json();
  assert.deepEqual(list.map(x => x.id), ["prv-0000000a"]);
  const csp = (await fetch(base)).headers.get("content-security-policy");
  assert.match(csp, /127\.0\.0\.1:4010/);
  assert.doesNotMatch(csp, /127\.0\.0\.1:4011/);
});

test("network setup is idempotent", async () => {
  const docker = fakeDocker();
  docker.quiet = async () => ({ ok: false, output: "Error response from daemon: network with name rt-pvnet-0123456z already exists" });
  await createPreviewNetwork(docker, ID);
  docker.quiet = async () => ({ ok: false, output: "permission denied" });
  await assert.rejects(createPreviewNetwork(docker, ID), /cannot create the preview network/);
});

// ---- embedding -----------------------------------------------------------

test("CSP: frame-src gets exactly the previews' loopback origins; nothing else changes", () => {
  const origins = ["http://127.0.0.1:4001", "http://127.0.0.1:4002"];
  const dash = withFrameSrc(DASHBOARD_CSP, origins);
  assert.match(dash, /(^|; )frame-src http:\/\/127\.0\.0\.1:4001 http:\/\/127\.0\.0\.1:4002($|;)/);
  assert.equal(dash.replace(/; frame-src [^;]*$/, ""), DASHBOARD_CSP, "everything else is unchanged");
  assert.match(dash, /default-src 'none'/);
  const room = withFrameSrc(ROOM_CSP, origins);
  assert.match(room, /frame-src 'self' http:\/\/127\.0\.0\.1:4001 http:\/\/127\.0\.0\.1:4002;/);
  assert.equal(withFrameSrc(INDEX_CSP, []), INDEX_CSP);
  const evil = withFrameSrc(INDEX_CSP, ["http://0.0.0.0:80", "*", "http://127.0.0.1:4001; script-src *", "http://127.0.0.1:4003"]);
  assert.match(evil, /frame-src http:\/\/127\.0\.0\.1:4003$/);
  assert.doesNotMatch(evil, /script-src \*|0\.0\.0\.0/);
  assert.deepEqual(previewOrigins([{ origin: "http://127.0.0.1:4001" }, { origin: "http://127.0.0.1:4001" }, { origin: "http://evil.example" }]), ["http://127.0.0.1:4001"]);
});

function record(extra = {}) {
  return { id: ID, display: "live", container: "rt-preview-0123456z", origin: "http://127.0.0.1:4000", host_port: 4000, container_port: 3000, script: "dev",
    source: { kind: "task", execution: EXE, task: "t1" }, started_at: "2026-01-01T00:00:00Z", last_seen: "2026-01-01T00:00:00Z", ttl_ms: 1000, host: hostname(), ...extra };
}

test("frames: sandboxed without allow-same-origin; text is escaped and redacted", () => {
  const html = previewFramesHtml([record({ source: { kind: "prototype", prototype: "<script>alert(1)</script>" }, check: { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 1 } })]);
  assert.match(html, /<iframe class="preview" sandbox="allow-scripts allow-forms" src="http:\/\/127\.0\.0\.1:4000\/"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /page check: did not load/);
  assert.equal(previewFramesHtml([]), "");
  assert.equal(previewFramesHtml([record({ origin: "http://evil.example:80" })]), "");
  const secret = previewFramesHtml([record({ source: { kind: "prototype", prototype: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } })]);
  assert.doesNotMatch(secret, /abcdefghijklmnopqrstuvwxyz0123456789/);
});

test("display cards: click creates no frame; screenshot uses only a stored image and a new-tab link", async t => {
  await clean();
  t.after(clean);
  const click = previewFramesHtml([record({ display: "click" })]);
  assert.match(click, /Load preview/);
  assert.match(click, /task t1/);
  assert.match(click, /http:\/\/127\.0\.0\.1:4000/);
  assert.doesNotMatch(click, /<iframe|<img/);
  const r = record({ display: "screenshot" });
  writeRecord(r);
  let html = previewFramesHtml([r], "/cap/");
  assert.match(html, /No page-check screenshot yet/);
  assert.doesNotMatch(html, /<iframe|<img|Load preview/);
  writePreviewScreenshot(ID, Buffer.from("latest PNG"));
  html = previewFramesHtml([r], "/cap/");
  assert.match(html, /<img class="preview-shot" src="\/cap\/preview-shots\/prv-0123456z.png"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer">Open in a new tab/);
  assert.doesNotMatch(html, /<iframe|Load preview/);
  assert.deepEqual(inlineProblems(click + html), []);
  assert.deepEqual(previewOrigins([
    record({ display: "live" }), record({ display: "click", origin: "http://127.0.0.1:4001" }),
    record({ display: "screenshot", origin: "http://127.0.0.1:4002" }),
  ]), ["http://127.0.0.1:4000", "http://127.0.0.1:4001"]);
  assert.doesNotMatch(withFrameSrc(ROOM_CSP, previewOrigins([r])), /127\.0\.0\.1:4000/);
});

test("serve index shows running previews in sandboxed frames and stops reloading itself", () => {
  const page = renderIndex("/tok/", [], [], [], undefined, [record()]);
  assert.match(page, /sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(page, /allow-same-origin/);
  assert.doesNotMatch(renderIndex("/tok/", [], [], [], undefined, []), /<iframe/);
});

test("the room serves previews.json and adds frame-src only for running previews", async t => {
  await clean();
  const { room, fetch } = await roomHarness(t);
  t.after(async () => { await room.close(); await clean(); });
  const base = new URL(room.url);
  let page = await fetch(base);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /127\.0\.0\.1:\d/);
  assert.deepEqual(await (await fetch(new URL("previews.json", base))).json(), []);
  writeRecord(record({ source: { kind: "prototype", prototype: "P1v1", duel: "duel-room-test" } }));
  await room.observer.onEvent({ type: "start", id: "duel-room-test", topic: "t", mode: "duel", seats: [], startedAt: new Date().toISOString() });
  page = await fetch(base);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /frame-src 'self' http:\/\/127\.0\.0\.1:4000;/);
  assert.match(csp, /default-src 'none'; script-src 'self'/);
  const list = await (await fetch(new URL("previews.json", base))).json();
  assert.deepEqual(list, [{ id: ID, origin: "http://127.0.0.1:4000", label: "prototype P1v1", display: "live" }]);
  assert.match(await (await fetch(new URL("room.js", base))).text(), /allow-scripts allow-forms/);
  assert.doesNotMatch(await (await fetch(new URL("room.js", base))).text(), /allow-same-origin/);
});

test("room JSON carries display and screenshot; CSP omits screenshot origins and images are duel scoped", async t => {
  await clean();
  const { room, fetch } = await roomHarness(t);
  t.after(clean);
  const base = new URL(room.url);
  await room.observer.onEvent({ type: "start", id: "duel-display", topic: "t", mode: "duel", seats: [], startedAt: new Date().toISOString() });
  for (const [index, display] of ["live", "click", "screenshot"].entries()) {
    const id = `prv-0000000${index}`;
    writeRecord(record({ id, container: `rt-preview-0000000${index}`, display, host_port: 4010 + index, origin: `http://127.0.0.1:${4010 + index}`, source: { kind: "prototype", prototype: "p", duel: "duel-display" } }));
    writePreviewScreenshot(id, Buffer.from(`PNG${index}`));
  }
  const list = await (await fetch(new URL("previews.json", base))).json();
  assert.deepEqual(list.map(r => r.display), ["live", "click", "screenshot"]);
  assert.equal(list[2].screenshot, "preview-shots/prv-00000002.png");
  const page = await fetch(base);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /frame-src 'self' http:\/\/127\.0\.0\.1:4010 http:\/\/127\.0\.0\.1:4011;/);
  assert.doesNotMatch(csp, /127\.0\.0\.1:4012/);
  assert.match(await page.text(), /name="roundtable-preview-origins" content="http:\/\/127\.0\.0\.1:4010 http:\/\/127\.0\.0\.1:4011"/);
  let shot = await fetch(new URL(list[2].screenshot, base));
  assert.equal(shot.headers.get("content-type"), "image/png");
  assert.equal(await shot.text(), "PNG2");
  writePreviewScreenshot("prv-00000002", Buffer.from("latest PNG"));
  shot = await fetch(new URL(list[2].screenshot, base));
  assert.equal(await shot.text(), "latest PNG");
  writeRecord(record({ source: { kind: "prototype", prototype: "other", duel: "duel-other" } }));
  writePreviewScreenshot(ID, Buffer.from("other duel"));
  assert.equal((await fetch(new URL(`preview-shots/${ID}.png`, base))).status, 404);
  assert.equal((await fetch(new URL("preview-shots/prv-99999999.png", base))).status, 404);
});

// ---- CLI -----------------------------------------------------------------

test("CLI argument parsing", () => {
  assert.deepEqual(parsePreviewArgs(["start", EXE, "t1", "--script", "start", "--port", "8080"]), { kind: "start", input: { execution: EXE, task: "t1", script: "start", port: 8080 } });
  assert.deepEqual(parsePreviewArgs(["start", "--prototype", "/x/P1v1"]), { kind: "start", input: { prototype: "/x/P1v1" } });
  assert.deepEqual(parsePreviewArgs(["list", "--json"]), { kind: "list", json: true });
  assert.deepEqual(parsePreviewArgs(["stop", ID]), { kind: "stop", id: ID });
  for (const bad of [[], ["start"], ["start", EXE], ["start", "nope", "t1"], ["start", EXE, "t1", "--prototype", "/x"], ["stop", "x"], ["start", "--prototype", "/x", "--port", "abc"], ["frob"], ["start", EXE, "t1", "--host", "0.0.0.0"]]) {
    assert.throws(() => parsePreviewArgs(bad));
  }
});

// ---- real Docker (opt in) -------------------------------------------------

test("real Docker: a tiny dev server is previewed on 127.0.0.1 and removed", { skip: process.env.ROUNDTABLE_TEST_DOCKER !== "1" }, async t => {
  const { execFileSync } = await import("node:child_process");
  const dir = prototypeDir("P9v1", { scripts: { dev: "node server.js" } });
  writeFileSync(join(dir, "server.js"),
    "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1>hello preview</h1>')}).listen(Number(process.env.PORT),process.env.HOST)\n");
  const deps = { ...defaultDeps(), pageCheck: async () => ({ loaded: true, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "disabled" }) };
  t.after(async () => { await stopAllPreviews(); });
  const r = await startPreview({ prototype: dir, port: 8080 }, deps);
  assert.match(r.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const body = await (await fetch(`${r.origin}/`)).text();
  assert.match(body, /hello preview/);
  const inspect = name => JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
  const server = inspect(r.container), fwd = inspect(`${r.container}-fwd`);
  assert.equal(server.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(server.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(server.HostConfig.PortBindings ?? {}, {}, "the server publishes nothing");
  assert.equal((server.Mounts ?? []).filter(m => m.Type === "bind").length, 0);
  assert.deepEqual(Object.keys(server.NetworkSettings.Networks), [`rt-pvnet-${r.id.slice(4)}`]);
  assert.deepEqual(Object.keys(fwd.NetworkSettings.Networks).sort(), [`rt-pvfwd-${r.id.slice(4)}`, `rt-pvnet-${r.id.slice(4)}`], "the forwarder has its own network, not the default bridge");
  assert.deepEqual(fwd.HostConfig.PortBindings["8080/tcp"], [{ HostIp: "127.0.0.1", HostPort: "" }]);
  assert.deepEqual(fwd.HostConfig.CapDrop, ["ALL"]);
  // No route out of the dev server's network.
  const out = execFileSync("docker", ["exec", r.container, "node", "-e",
    "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('REACHED'),()=>console.log('blocked'))"], { encoding: "utf8" });
  assert.match(out, /blocked/);
  assert.equal(await stopPreview(r.id), true);
  assert.equal(execFileSync("docker", ["ps", "-a", "--filter", "label=roundtable.preview", "-q"], { encoding: "utf8" }).trim(), "");
  assert.equal(execFileSync("docker", ["network", "ls", "--filter", "label=roundtable.preview-net", "-q"], { encoding: "utf8" }).trim(), "");
});
