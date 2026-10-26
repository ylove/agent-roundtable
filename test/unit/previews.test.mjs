import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { PROTOTYPE_DIR, WORKTREES_DIR } from "../../dist/config.js";
import { buildForwarderCreateArgs, buildInstallRunArgs, buildNetworkCreateArgs, buildPreviewRunArgs, forwarderName, previewContainerName, previewNetworkName } from "../../dist/previews/args.js";
import { defaultPort, parsePackageJson, pickScript, previewArgv, validatePort } from "../../dist/previews/scripts.js";
import { ORIGIN_RE, parseRecord, previewsDir, readRecords, writeRecord } from "../../dist/previews/store.js";
import { livePreviews, previewFramesHtml, previewOrigins, withFrameSrc } from "../../dist/previews/embed.js";
import { defaultDeps, createPreviewNetwork, parsePublishedPort, previewSettings, refreshPreviews, resolveSource, startPreview, stopAllPreviews, stopPreview, sweepPreviews } from "../../dist/previews/manager.js";
import { parsePreviewArgs } from "../../dist/cli-preview.js";
import { renderIndex, INDEX_CSP } from "../../dist/serve/index.js";
import { DASHBOARD_CSP } from "../../dist/dashboard/server.js";
import { ROOM_CSP } from "../../dist/table/room-assets.js";
import { hostname } from "node:os";
import { startRoom } from "../../dist/table/room.js";

const limits = { memory: "2g", cpus: "2", pids: 512 };
const ID = "prv-0123456z";
const EXE = "exe-0123456789abcdef";

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
  return { id: ID, container: "rt-preview-0123456z", origin: "http://127.0.0.1:4000", host_port: 4000, container_port: 3000, script: "dev",
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

test("serve index shows running previews in sandboxed frames and stops reloading itself", () => {
  const page = renderIndex("/tok/", [], [], [], undefined, [record()]);
  assert.match(page, /sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(page, /allow-same-origin/);
  assert.doesNotMatch(renderIndex("/tok/", [], [], [], undefined, []), /<iframe/);
});

test("the room serves previews.json and adds frame-src only for running previews", async t => {
  await clean();
  const room = await startRoom({ open: false, hold: false });
  t.after(async () => { await room.close(); await clean(); });
  const base = new URL(room.url);
  let page = await fetch(base);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /127\.0\.0\.1:\d/);
  assert.deepEqual(await (await fetch(new URL("previews.json", base))).json(), []);
  writeRecord(record({ source: { kind: "prototype", prototype: "P1v1" } }));
  page = await fetch(base);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /frame-src 'self' http:\/\/127\.0\.0\.1:4000;/);
  assert.match(csp, /default-src 'none'; script-src 'self'/);
  const list = await (await fetch(new URL("previews.json", base))).json();
  assert.deepEqual(list, [{ id: ID, origin: "http://127.0.0.1:4000", label: "prototype P1v1" }]);
  assert.match(await (await fetch(new URL("room.js", base))).text(), /allow-scripts allow-forms/);
  assert.doesNotMatch(await (await fetch(new URL("room.js", base))).text(), /allow-same-origin/);
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
