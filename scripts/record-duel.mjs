#!/usr/bin/env node
// Dev script: records the bundled synthetic duel (`duel --dry-run`) in the live room and encodes the README GIF
// plus 16:9 MP4s for social posts. It builds nothing itself: run `npm run build` first. Needs Chrome and ffmpeg.
//
//   node scripts/record-duel.mjs <out-dir> [--speed 2.5] [--gif docs/assets/live-duel.gif] [--keep-frames]
//
// Writes live-duel-1280.mp4 and live-duel-1080.mp4 to <out-dir> (not committed) and the GIF to --gif.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const outDir = args.find((a, i) => !a.startsWith("--") && !["--speed", "--gif"].includes(args[i - 1]));
if (!outDir) { console.error("usage: node scripts/record-duel.mjs <out-dir> [--speed n] [--gif path] [--keep-frames]"); process.exit(2); }
const speed = Number(flag("--speed") ?? 2.5);
const gifPath = resolve(flag("--gif") ?? join(root, "docs/assets/live-duel.gif"));
const ffmpeg = process.env.FFMPEG ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const WIDTH = 1280, HEIGHT = 720, SCALE = 2, INTERVAL_MS = 100, AFTER_BANNER_MS = 3000, MAX_MS = 120_000;

if (!existsSync(join(dist, "index.js"))) { console.error("dist/ is missing: run `npm run build` first."); process.exit(2); }
const { findChrome, launchBrowser, CdpPipe, browserArgs } = await import(join(dist, "prototypes/browser.js"));
const chromePath = findChrome();
if (!chromePath) { console.error("Chrome not found (set ROUNDTABLE_CHROME_PATH)."); process.exit(2); }

const cleanups = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup().finally(() => process.exit(130)); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const work = await mkdtemp(join(tmpdir(), "record-duel-"));
  cleanups.push(() => args.includes("--keep-frames") ? undefined : rm(work, { recursive: true, force: true }));
  await mkdir(join(work, "home"), { recursive: true });
  await mkdir(join(work, "frames"), { recursive: true });
  await mkdir(resolve(outDir), { recursive: true });
  await mkdir(dirname(gifPath), { recursive: true });

  // Chrome first, so the page is ready to navigate the moment the room announces its address.
  const browser = launchBrowser(chromePath, [...browserArgs("http://127.0.0.1:1", join(work, "profile")).map(a => a.startsWith("--proxy-bypass-list=") ? "--proxy-bypass-list=127.0.0.1" : a), "--remote-debugging-pipe", "about:blank"], work);
  cleanups.push(() => browser.stop());
  const cdp = new CdpPipe(browser.child.stdio[3], browser.child.stdio[4]);
  browser.child.on("exit", () => cdp.close());
  await sleep(500);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const targetId = targetInfos.find(t => t.type === "page").targetId;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId).catch(e => { throw new Error(`${method}: ${e.message}`); });
  await cdp.send("Target.activateTarget", { targetId });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });

  // The synthetic duel, with the room held open until capture finishes.
  const env = { ...process.env, ROUNDTABLE_HOME: join(work, "home"), ROUNDTABLE_DOTENV: "off", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", TOGETHER_API_KEY: "", REPLICATE_API_TOKEN: "", OPENAI_COMPATIBLE_BASE_URL: "" };
  const duel = spawn(process.execPath, [join(dist, "index.js"), "duel", "--dry-run", "--speed", String(speed)], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  cleanups.push(() => { try { process.kill(-duel.pid, "SIGKILL"); } catch { duel.kill("SIGKILL"); } });
  const url = await new Promise((res, rej) => {
    let text = "";
    const timer = setTimeout(() => rej(new Error("the room did not announce its address")), 20_000);
    duel.stderr.on("data", chunk => { text += chunk; const m = /Room: (\S+)/.exec(text); if (m) { clearTimeout(timer); res(m[1]); } });
    duel.on("exit", code => rej(new Error(`duel exited early (${code})`)));
  });
  const loaded = new Promise(res => { cdp.onEvent = method => { if (method === "Page.loadEventFired") res(); }; });
  const nav = await send("Page.navigate", { url });
  if (nav.errorText) throw new Error(nav.errorText);
  await loaded;

  // Capture at a steady rate until about 3 s after the winner banner appears. Each frame keeps its capture time.
  const frames = [];
  const t0 = Date.now();
  let bannerAt = 0, n = 0;
  while (Date.now() - t0 < MAX_MS) {
    const started = Date.now();
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true, fromSurface: true });
    const file = join(work, "frames", `f${String(n++).padStart(5, "0")}.jpg`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    frames.push({ file, at: started });
    if (!bannerAt && n % 5 === 0) {
      const r = await send("Runtime.evaluate", { expression: "(() => { const b = document.getElementById('banner'); return !!b && !b.hidden && b.textContent.trim().length > 0; })()", returnByValue: true });
      if (r.result?.value) bannerAt = Date.now();
    }
    if (bannerAt && Date.now() - bannerAt >= AFTER_BANNER_MS) break;
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)));
  }
  if (!bannerAt) throw new Error("the winner banner never appeared");
  console.log(`captured ${frames.length} frames over ${((frames.at(-1).at - frames[0].at) / 1000).toFixed(1)} s`);

  // Frames go in by capture time, so uneven capture still plays back at real speed.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.at ?? f.at + INTERVAL_MS) - f.at) / 1000}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
  const listFile = join(work, "frames.txt");
  await writeFile(listFile, list);
  const run = (...a) => { const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, ...a], { stdio: ["ignore", "inherit", "inherit"] }); if (r.status !== 0) throw new Error("ffmpeg failed"); };

  const gifFilter = "fps=12,scale=960:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=2.5,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle";
  run("-filter_complex", gifFilter, "-loop", "0", gifPath);
  for (const [name, w, h] of [["live-duel-1280.mp4", 1280, 720], ["live-duel-1080.mp4", 1920, 1080]]) {
    run("-vf", `fps=30,scale=${w}:${h}:flags=lanczos:in_range=full:out_range=limited,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", "-an", join(resolve(outDir), name));
  }
  if (args.includes("--keep-frames")) console.log(`frames kept in ${join(work, "frames")}`);
  console.log(`GIF ${gifPath} (${((await stat(gifPath)).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`MP4s in ${resolve(outDir)}`);
}

main().then(() => cleanup().then(() => process.exit(0)), async err => { console.error(err.stack ?? err); await cleanup(); process.exit(1); });
