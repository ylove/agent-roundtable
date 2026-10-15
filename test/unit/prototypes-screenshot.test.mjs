import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmpd = async (prefix) => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

// A stand-in browser. Default: exit at once. Mode "args" records its argv, its temp-dir environment and
// its whole environment (to <out>.env); "hang" records its pid and keeps recreating its profile directory
// (as a live Chrome would). Mode and output path come from control files beside the script: Chrome gets
// an allowlisted environment, so variables a test sets never reach it.
const fakeDir = await tmpd("rt-chrome-");
const fakeChrome = join(fakeDir, "fake-chrome");
await writeFile(
  fakeChrome,
  `#!/bin/sh
ctl='${fakeDir}'
mode=$(cat "$ctl/mode" 2>/dev/null)
out=$(cat "$ctl/out" 2>/dev/null)
case "$mode" in
  args)
    printf '%s\\n' "$@" > "$out"
    printf 'TMPDIR=%s\\nTMP=%s\\nTEMP=%s\\nMAC_CHROMIUM_TMPDIR=%s\\n' "$TMPDIR" "$TMP" "$TEMP" "$MAC_CHROMIUM_TMPDIR" >> "$out"
    env > "$out.env" ;;
  hang)
    for a in "$@"; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}" ;; esac; done
    echo $$ >> "$out"
    while true; do mkdir -p "$d/Default" 2>/dev/null; sleep 0.05; done ;;
esac
exit 0
`
);
await chmod(fakeChrome, 0o755);
// The override is read from the environment when config.js is first imported.
const useRealChrome = process.env.ROUNDTABLE_TEST_CHROME === "1";
if (!useRealChrome) process.env.ROUNDTABLE_CHROME_PATH = fakeChrome;

const { findChrome, captureScreenshots, ChromeProcesses, DESKTOP_VIEWPORT, MOBILE_VIEWPORT } = await import("../../dist/prototypes/screenshot.js");
const { PrototypeTracker } = await import("../../dist/prototypes/index.js");

const posix = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 15000, description = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${description}`);
    await sleep(20);
  }
}
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
};

// A browser's exit event need not mean its helpers have exited yet. On POSIX the
// negative pid probes its entire process group, including those helpers.
const groupsGone = (pids) => pids.every((pid) => gone(pid) && gone(-pid));

/** Set the fake browser's mode and output file for this test only. */
function fakeMode(t, mode, out) {
  writeFileSync(join(fakeDir, "mode"), mode);
  writeFileSync(join(fakeDir, "out"), out);
  t.after(() => {
    rmSync(join(fakeDir, "mode"), { force: true });
    rmSync(join(fakeDir, "out"), { force: true });
  });
}

test("findChrome: honors ROUNDTABLE_CHROME_PATH and caches; a missing override falls back", { skip: !posix || useRealChrome }, () => {
  assert.equal(findChrome(), fakeChrome);
  assert.equal(findChrome(), fakeChrome);
  assert.notEqual(findChrome(join(fakeDir, "missing")), join(fakeDir, "missing"));
  assert.equal(findChrome(fakeChrome), fakeChrome);
});

test("viewports: desktop 1280x800, mobile 390x844", () => {
  assert.deepEqual(DESKTOP_VIEWPORT, { name: "desktop", width: 1280, height: 800 });
  assert.deepEqual(MOBILE_VIEWPORT, { name: "mobile", width: 390, height: 844 });
});

test("captureScreenshots: only the local board, never throws, empty when nothing was written", { skip: !posix }, async () => {
  const out = await tmpd("rt-shots-");
  assert.deepEqual(await captureScreenshots("https://example.com/", out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome }), []);
  assert.deepEqual(await captureScreenshots("http://localhost:9/x", out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome }), []);
  assert.deepEqual(await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome }), []);
  assert.deepEqual(await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT], { chromePath: join(fakeDir, "nope") }), []);
  assert.deepEqual(readdirSync(out).filter((n) => n.startsWith(".chrome-")), [], "profile dirs removed");
});

test("captureScreenshots: Chrome runs behind the board as a deny-all proxy, with its temp files in the shots dir", { skip: !posix }, async (t) => {
  const out = await tmpd("rt-shots-");
  const record = join(await tmpd("rt-chrome-"), "args.txt");
  fakeMode(t, "args", record);
  process.env.ANTHROPIC_API_KEY = "sk-ant-never-reaches-chrome";
  process.env.ROUNDTABLE_WEBHOOK_AUTH_HEADER = "Authorization: Bearer never-reaches-chrome";
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ROUNDTABLE_WEBHOOK_AUTH_HEADER;
  });
  const url = "http://127.0.0.1:4567/tok3n/p/P1v1/app/index.html";
  await captureScreenshots(url, out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome });
  const args = lines(record);
  for (const flag of [
    "--proxy-server=http://127.0.0.1:4567",
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--headless=new",
  ]) {
    assert.ok(args.includes(flag), `${flag} in ${args.join(" ")}`);
  }
  for (const name of ["TMPDIR", "TMP", "TEMP", "MAC_CHROMIUM_TMPDIR"]) assert.ok(args.includes(`${name}=${out}`), `${name}: ${args.join(" ")}`);
  assert.ok(args.includes(url));
  // The browser allowlist: no provider keys, no publisher credentials.
  const env = readFileSync(`${record}.env`, "utf8");
  assert.ok(!env.includes("never-reaches-chrome"), env);
  assert.match(env, /^PATH=/m);
});

test("captureScreenshots: a hung browser is killed at the timeout", { skip: !posix }, async () => {
  const slow = join(fakeDir, "slow-chrome");
  await writeFile(slow, "#!/bin/sh\nsleep 30\n");
  await chmod(slow, 0o755);
  const out = await tmpd("rt-shots-");
  const t0 = Date.now();
  const res = await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT, MOBILE_VIEWPORT], { chromePath: slow, timeoutMs: 200 });
  assert.deepEqual(res, []);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test("ChromeProcesses: killAll stops captures in flight (the whole process group) and any later start", { skip: !posix }, async (t) => {
  const out = await tmpd("rt-shots-");
  const pidsFile = join(await tmpd("rt-chrome-"), "pids.txt");
  fakeMode(t, "hang", pidsFile);
  const procs = new ChromeProcesses();
  const capture = captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT, MOBILE_VIEWPORT], {
    chromePath: fakeChrome,
    processes: procs,
  });
  await waitFor(() => lines(pidsFile).length === 2 && procs.running.length === 2);
  const pids = lines(pidsFile).map(Number);
  // Wait until both browsers really have written their profiles before killing
  // them; a pid alone is published before the fake browser starts its helpers.
  await waitFor(() => ["desktop", "mobile"].every((name) => existsSync(join(out, `.chrome-${name}`, "Default"))));
  const t0 = Date.now();
  procs.killAll();
  assert.deepEqual(await capture, []);
  await waitFor(() => groupsGone(pids), 15000, "browser process groups to exit");
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  assert.ok(pids.every(gone), "browsers killed");
  assert.ok(groupsGone(pids), "browser helpers killed");
  assert.deepEqual(readdirSync(out), [], "nothing (helpers included) recreates the profile directories");
  // A capture that starts after killAll never leaves a browser running.
  assert.deepEqual(await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome, processes: procs }), []);
  assert.equal(lines(pidsFile).length, 2);
});

for (const how of ["closeSync", "close"]) {
  test(`tracker: ${how}() with a screenshot in flight kills the browser before removing the sandbox`, { skip: !posix || useRealChrome }, async (t) => {
    const pidsFile = join(await tmpd("rt-chrome-"), "pids.txt");
    fakeMode(t, "hang", pidsFile);
    const tr = await PrototypeTracker.create({
      sessionId: "exit",
      mode: "collaborate",
      participants: ["a", "b"],
      assessorIsCaller: false,
      public: true,
      screenshots: true,
      openBrowser: false,
      root: await tmpd("rt-proto-shots-"),
    });
    t.after(() => tr.close("ended"));
    const turn = tr.onTurn(0, `<prototype title="slow" kind="web"><file path="index.html"><h1>hi</h1></file></prototype>`, 1);
    await waitFor(() => lines(pidsFile).length === 2);
    if (how === "closeSync") tr.closeSync();
    else await tr.close("ended");
    const r = await turn;
    assert.deepEqual(r.attachments, []);
    const pids = lines(pidsFile).map(Number);
    await waitFor(() => groupsGone(pids), 15000, "browser process groups to exit");
    assert.ok(pids.every(gone), "browsers killed");
    assert.ok(groupsGone(pids), "browser helpers killed");
    assert.equal(existsSync(tr.sessionDir), false, "nothing recreated the sandbox");
    assert.equal(tr.hasLiveUnderAssessment(), false);
  });
}

/** Minimal PNG decoder (8-bit RGB/RGBA, as Chrome writes): pixel(x, y) -> [r, g, b]. */
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit");
      bpp = { 2: 3, 6: 4 }[data[9]];
      assert.ok(bpp, `color type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, pixel: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}
const near = (rgb, want) => rgb.every((v, i) => Math.abs(v - want[i]) <= 8);

test("real Chrome: a public web prototype renders (CSS and classic script from its own files) in desktop and mobile PNGs", { skip: !useRealChrome && "set ROUNDTABLE_TEST_CHROME=1 to run" }, async (t) => {
  assert.ok(findChrome(), "Chrome not found");
  const tr = await PrototypeTracker.create({
    sessionId: "shots",
    mode: "collaborate",
    participants: ["a", "b"],
    assessorIsCaller: false,
    public: true,
    screenshots: true,
    openBrowser: false,
    root: await tmpd("rt-proto-shots-"),
  });
  t.after(() => tr.close("ended"));
  const r = await tr.onTurn(
    0,
    `<prototype title="Coupon" kind="web">` +
      `<file path="index.html"><!doctype html><html><head><link rel="stylesheet" href="style.css"></head>` +
      `<body><h1>Coupon</h1><input><button>Apply</button><script src="app.js"></script></body></html></file>` +
      `<file path="style.css">html,body{margin:0;background:#ff00ff}</file>` +
      `<file path="app.js">var b=document.createElement("div");b.style.cssText="position:fixed;left:0;top:0;width:100%;height:40px;background:#00ff00";document.body.appendChild(b);</file>` +
      `<demo>impatient; impaired; expert</demo></prototype>`,
    1
  );
  assert.equal(r.created.label, "P1 v1");
  assert.deepEqual(r.attachments.map((a) => a.filename).sort(), ["P1v1-desktop.png", "P1v1-mobile.png"]);
  for (const a of r.attachments) {
    assert.equal(a.contentType, "image/png");
    assert.ok(a.bytes.length > 1000);
    assert.match(a.caption, /^P1 v1 screenshot \((desktop|mobile)\)$/);
    const img = decodePng(a.bytes);
    assert.equal(img.width, a.filename.includes("desktop") ? 1280 : 390);
    assert.ok(near(img.pixel(5, 10), [0, 255, 0]), `script ran (${a.filename}): ${img.pixel(5, 10)}`);
    assert.ok(near(img.pixel(img.width - 5, img.height - 5), [255, 0, 255]), `stylesheet applied (${a.filename}): ${img.pixel(img.width - 5, img.height - 5)}`);
  }
  const shots = join(tr.sessionDir, "P1v1", "shots");
  assert.ok(existsSync(join(shots, "desktop.png")));
  assert.deepEqual(readdirSync(shots).filter((n) => n.startsWith(".chrome-")), []);
  await tr.onTurn(1, "Verdict on P1: APPROVE — fine", 2);
  assert.equal(existsSync(shots), false, "screenshots destroyed with the prototype");
});

test("real Chrome: a page that navigates to another local server or to the internet captures neither (SSRF)", { skip: !useRealChrome && "set ROUNDTABLE_TEST_CHROME=1 to run" }, async (t) => {
  let markerHits = 0;
  const marker = createServer((req, res) => {
    markerHits++;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1 style='font-size:60px;background:#ff0000'>INTERNAL-MARKER token=abc123</h1>");
  });
  await new Promise((r) => marker.listen(0, "127.0.0.1", r));
  t.after(() => marker.close());
  const mport = marker.address().port;

  const tr = await PrototypeTracker.create({
    sessionId: "ssrf",
    mode: "collaborate",
    participants: ["a", "b"],
    assessorIsCaller: false,
    public: true,
    screenshots: true,
    openBrowser: false,
    root: await tmpd("rt-proto-shots-"),
  });
  t.after(() => tr.close("ended"));
  // Everything the screenshot browser asks its proxy (the board) for.
  const seen = [];
  const server = tr["board"]["server"];
  server.on("request", (req) => seen.push(req.url));
  server.on("connect", (req) => seen.push(`CONNECT ${req.url}`));

  const pages = [
    `<meta http-equiv="refresh" content="0;url=http://localhost:${mport}/admin">`,
    `<script>location.href = "http://127.0.0.1:${mport}/admin";</script>`,
    `<meta http-equiv="refresh" content="0;url=http://example.com/">`,
    `<meta http-equiv="refresh" content="0;url=https://example.com/">`,
    `<img src="http://localhost:${mport}/pixel.png"><iframe src="http://127.0.0.1:${mport}/frame"></iframe>`,
  ];
  for (const [i, html] of pages.entries()) {
    const r = await tr.onTurn(0, `<prototype title="Redirect ${i}" kind="web"><file path="index.html"><!doctype html>${html}<p>Redirecting…</p></file></prototype>`, i + 1);
    assert.equal(r.created?.label, `P${i + 1} v1`, r.rejected);
    assert.equal(r.attachments.length, 2, `page ${i}: captured\n${seen.join("\n")}`);
    for (const a of r.attachments) {
      const img = decodePng(a.bytes);
      for (const [x, y] of [[5, 5], [100, 30], [300, 40]]) {
        assert.ok(!near(img.pixel(x, y), [255, 0, 0]), `page ${i} ${a.filename}: the marker page was rendered`);
      }
    }
  }
  assert.equal(markerHits, 0, "the other local server was never contacted");
  // The navigations reached the board as proxy requests and were refused there.
  assert.ok(seen.some((u) => u.startsWith(`http://localhost:${mport}/`)), seen.join("\n"));
  assert.ok(seen.some((u) => u.startsWith(`http://127.0.0.1:${mport}/`)), seen.join("\n"));
  assert.ok(seen.some((u) => u.startsWith("http://example.com/")), seen.join("\n"));
  assert.ok(seen.includes("CONNECT example.com:443"), seen.join("\n"));
});

test("real Chrome: closeSync() mid-capture (process exit) leaves no browser and no files", { skip: !useRealChrome && "set ROUNDTABLE_TEST_CHROME=1 to run" }, async (t) => {
  const root = await tmpd("rt-proto-shots-");
  const tr = await PrototypeTracker.create({
    sessionId: "exit",
    mode: "collaborate",
    participants: ["a", "b"],
    assessorIsCaller: false,
    public: true,
    screenshots: true,
    openBrowser: false,
    root,
  });
  t.after(() => tr.close("ended"));
  const turn = tr.onTurn(0, `<prototype title="slow" kind="web"><file path="index.html"><h1>hi</h1><script>setTimeout(function(){document.body.append("late")},2500)</script></file></prototype>`, 1);
  await waitFor(() => tr["chrome"].running.length > 0, 10000);
  const pids = tr["chrome"].running;
  // Chrome's temporary files (its process-singleton directory included) are inside the shots directory.
  const shots = join(tr.sessionDir, "P1v1", "shots");
  const link = join(shots, ".chrome-desktop", "SingletonSocket");
  await waitFor(() => {
    try {
      return !!readlinkSync(link);
    } catch {
      return false;
    }
  }, 10000);
  assert.ok(readlinkSync(link).startsWith(shots + "/"), readlinkSync(link));
  tr.closeSync();
  await turn;
  await sleep(2500);
  assert.ok(pids.every(gone), "browsers killed");
  assert.deepEqual(readdirSync(root), [".gitignore"], "the sandbox stays removed");
});
