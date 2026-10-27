export const ROOM_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const ROOM_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><!-- action nonce -->
<title>Duel at the table</title><link rel="stylesheet" href="room.css"><script src="room.js" defer></script></head>
<body><header><div class="heading"><p class="eyebrow">At the table / Live duel</p><h1 id="topic">Waiting for the duel</h1></div><nav id="view-switch" class="segmented" aria-label="Room view"><button id="apps-tab" type="button" aria-pressed="true">Apps</button><button id="harness-tab" type="button" aria-pressed="false">Harness</button></nav><div id="header-controls"></div></header>
<div id="banner" role="status" hidden></div><p id="control-note" role="status"></p>
<main><section id="artifacts" aria-label="Team apps"></section><section id="harness" hidden><div id="team-transcripts"></div><section id="shared" aria-label="Judging and closing statements"><h2>Judges &amp; closing statements</h2><div id="judges"></div><div id="verdicts"></div><h2>Dissents</h2><div id="dissents"></div><h2>Closing statements</h2><div id="closings"></div></section></section>
<details aria-label="Shared browser"><summary>Browser · checked screenshots</summary><p id="browser-note">No page checked yet.</p><img id="browser-shot" alt="Latest checked page" hidden></details>
<section id="previews" aria-label="Live previews" hidden><h2>Live previews</h2><p id="preview-note"></p><div id="preview-frames"></div></section></main><footer id="spend">Estimated spend: $0.0000</footer></body></html>`;

export const ROOM_CSS = String.raw`:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b1018;color:#e6edf6;font-synthesis:none}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:18px 22px;max-width:1800px;margin-inline:auto}header{display:flex;align-items:center;gap:18px;margin-bottom:14px}.heading{flex:1;min-width:0}.eyebrow{margin:0 0 5px;color:#8ba9c9;font-size:11px;letter-spacing:.17em;text-transform:uppercase}h1{font-size:22px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0}h2{font-size:17px;margin:0 0 8px}h3{font-size:13px}button{font:inherit;font-size:12px;border:1px solid #35465c;border-radius:6px;background:#162132;color:#dbe7f5;padding:6px 10px;cursor:pointer}button:hover{background:#22354e}button:focus-visible,a:focus-visible{outline:2px solid #a8cbff;outline-offset:3px}button:disabled{opacity:.5;cursor:default}button.active,button[aria-pressed=true]{background:#263c59;border-color:#89b4ec}.segmented{display:flex;padding:3px;background:#101b29;border:1px solid #293b51;border-radius:9px;gap:3px}.segmented button{border-color:transparent}.stop{color:#ffc8bb}#banner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid #42637e;background:#152638;border-radius:9px;padding:10px 14px;margin-bottom:12px;font-size:13px}#banner code{color:#b2d4fb;overflow-wrap:anywhere}#banner span{color:#b5c9df}#artifacts,#team-transcripts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.team{min-width:0;border:1px solid #2b3b4e;border-radius:12px;padding:13px;background:#111c2a;box-shadow:0 6px 24px #0003;position:relative}.team.finished{border-color:#548f7a}.team.finished .status{color:#8fdfb7}.team.chosen{border-color:#9ce6bf;box-shadow:0 0 0 1px #9ce6bf,0 0 28px #519b6c25}.team-seats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 10px;align-content:start;margin-bottom:9px}.seat{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px}.seat strong{flex-shrink:0;font-size:11px}.chip{display:inline-block;border:1px solid #334861;background:#18283a;border-radius:4px;padding:2px 5px;color:#a6bfdc;font-size:10px;max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.progress{display:flex;gap:4px}.segment{flex:1;min-width:0;padding:6px 4px;border-top:3px solid #354459;background:#182332;color:#a1b3c9;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:3px}.segment.started{color:#c7e4ff;border-color:#8cc8ff;animation:building 1.6s ease-in-out infinite}.segment.done{border-color:#6fc49b;color:#a9e4c7;background:#172f2a}.segment.failed{border-color:#ed9989;color:#f0b5a9;background:#35252a}.segment.skipped{border-color:#b6a57b;border-top-style:dashed;color:#c4b994}.segment.paused{animation:none}.status{font-size:14px;font-weight:600;margin:10px 0 4px;color:#c7dcf6}.ticker{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#91a6c0;margin:0 0 10px}.live{height:clamp(220px,calc(100dvh - 405px),620px);position:relative;background:#0a111b;border:1px solid #304259;border-radius:7px;overflow:hidden}.live iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:white}.live .incoming{visibility:hidden}.placeholder{display:grid;place-content:center;height:100%;margin:0;padding:18px;color:#7188a3;font-size:13px;text-align:center}.build-badge{position:absolute;right:24px;top:190px;z-index:2;background:#0e263eee;color:#d5edff;font-size:11px;padding:5px 8px;border:1px solid #61819f;border-radius:5px;opacity:0;pointer-events:none;transition:opacity .3s}.build-badge.fresh{opacity:1}.metrics{display:flex;flex-wrap:wrap;gap:5px 12px;padding:10px 0;color:#b6c9df;font:11px ui-monospace,SFMono-Regular,monospace;min-height:33px}.versions{display:flex;gap:5px;overflow:auto;align-items:center;padding-bottom:3px}.versions button{flex:none;font-size:10px;padding:4px 7px}.tools{margin-top:5px}.tools button{padding:3px 7px;font-size:10px;color:#98adc7}.new-version{color:#b8e0ff}.approval{display:flex;gap:8px}.approval:empty{display:none}.approve{flex:1;margin-top:9px;padding:11px;background:#214a3a;border-color:#67a787;color:#d4ffe7;font-size:14px;font-weight:600}.harness-column{min-width:0}.harness-column>.team{margin-bottom:16px}.entry,.verdict{background:#111c2a;border:1px solid #2b3b4e;border-radius:8px;padding:13px;margin:9px 0;font-size:13px;overflow-wrap:anywhere}.entry p,.verdict p{white-space:pre-wrap;line-height:1.6;color:#bacce0;margin-bottom:0}.entry strong,.verdict strong{font-size:12px;color:#9cbbde}#shared{margin-top:24px;border-top:1px solid #304259;padding-top:20px}#verdicts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.verdict[data-verdict=APPROVE]{border-color:#477e69}.verdict[data-verdict=REJECT]{border-color:#9f625e}.verdict[data-verdict=REVISE]{border-color:#9f8a5e}details{margin-top:20px}summary{cursor:pointer;color:#9eb6d2}#browser-shot,.snapshot{max-width:100%;height:auto}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:8px}.comparison iframe{width:100%;height:220px;border:0;background:white}.source{margin:0;min-height:220px;height:100%;overflow:auto;padding:12px;background:#09111c;color:#dbe6f3;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.live>div{height:100%;display:flex;flex-direction:column}.tabs{display:flex;gap:5px;padding:7px;overflow:auto}.diff{max-height:300px;overflow:auto;font-size:12px;white-space:pre-wrap}footer{font-size:11px;color:#7f96b1;margin-top:12px}#control-note{font-size:12px;color:#c9b58e;margin:5px 0}#control-note:empty{display:none}#previews iframe{width:100%;height:440px;border:0;background:white}.live.scaled{height:auto;aspect-ratio:10/5.8;--s:.6}.live.scaled iframe{inset:auto;top:0;left:0;width:calc(100% / var(--s));height:calc(100% / var(--s));transform:scale(var(--s));transform-origin:top left}@media(min-width:960px) and (max-width:1265px){.live.scaled{--s:.5}}@media(min-width:1266px) and (max-width:1495px){.live.scaled{--s:.6}}@media(min-width:1496px) and (max-width:1725px){.live.scaled{--s:.7}}@media(min-width:1726px){.live.scaled{--s:.8}}@media(max-width:959px){.live.scaled{--s:.8}}@media(max-width:800px){.live.scaled{--s:.7}}@media(max-width:700px){.live.scaled{--s:.6}}@media(max-width:580px){.live.scaled{--s:.5}}@media(max-width:480px){.live.scaled{--s:.4}}@media(max-width:380px){.live.scaled{--s:.35}}@keyframes building{50%{border-color:#3d6b9d;background:#20354b}}@media(min-width:960px) and (max-height:760px){body{padding-top:12px}.team{padding:10px}.team-seats{margin-bottom:6px}.status{margin-top:7px}.ticker{margin-bottom:7px}.live{height:calc(100dvh - 405px)}.tools{position:absolute;right:10px;bottom:10px;margin:0}.build-badge{top:95px;right:14px}.metrics{padding:7px 0;min-height:0}details{margin-top:10px}header{margin-bottom:10px}#banner:not([hidden])~main .live{height:calc(100dvh - 490px)}#banner:not([hidden])~main .live.scaled,.live.scaled{height:auto}}@media(max-width:959px){body{padding:14px}header{gap:10px;flex-wrap:wrap}.heading{flex-basis:65%}h1{font-size:19px}#artifacts,#team-transcripts{grid-template-columns:minmax(0,1fr)}.live{height:400px}.team{padding:12px}.chip{max-width:190px}}@media(prefers-reduced-motion:reduce){.segment.started{animation:none}.build-badge{transition:none}}`;

export const ROOM_JS = String.raw`"use strict";
const byId = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if(text !== undefined) element.textContent = text; if(className) element.className = className; return element; };
const spendText = (usd, tokens, unit) => { tokens = tokens || 0; const money = "$" + usd.toFixed(4); if (tokens <= 0) return money; const count = tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1).replace(/\.0$/, "") + "k"; const rest = count + " tok" + (unit ? " unpriced" : " (no price)"); return usd > 0 ? money + " + " + rest : rest; };
const short = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
const duration = ms => { const s = Math.floor(ms / 1000); return (s >= 60 ? Math.floor(s / 60) + "m " : "") + s % 60 + "s"; };
const line = text => (text || "").replace(/\s+/g, " ").trim();
const SOURCE_KINDS = ["code", "diagram", "text"];
const cards = new Map(), selections = new Map(), comparisons = new Set();
let current, confirming, busy = false, runId;
function button(text, action, className) { const b = node("button", text, className); b.type = "button"; b.addEventListener("click", action); return b; }
function setText(element, text) { if (element.textContent !== text) element.textContent = text; }
async function command(action, team) {
  if (busy) return;
  busy = true; render(current);
  try {
    const response = await fetch("control", { method: "POST", headers: { "Content-Type": "application/json", "X-Roundtable-Action": document.querySelector('meta[name="roundtable-action"]').content }, body: JSON.stringify(team ? { action, team } : { action }) });
    byId("control-note").textContent = response.ok ? "Request sent…" : response.status === 409 ? "That action is no longer available." : "Request refused. Reload the room and try again.";
    if (response.ok) confirming = undefined;
  } catch { byId("control-note").textContent = "Room disconnected. Try again when it reconnects."; }
  finally { busy = false; render(current); }
}
/* Source is inert text: never parsed as markup, never run. */
function sourceView(team, prototype, version) {
  const box = node("div"), tabs = node("div", undefined, "tabs"), pre = node("pre", "Loading…", "source");
  tabs.setAttribute("role", "tablist"); pre.tabIndex = 0; pre.setAttribute("aria-label", "Team " + team + " " + prototype.kind + " source");
  const buttons = []; let latest = 0;
  const show = async (file, selected) => {
    const mine = ++latest; buttons.forEach(b => b.setAttribute("aria-selected", String(b === selected))); pre.textContent = "Loading…";
    try { const r = await fetch("p/" + team + "/" + file.path + "?v=" + version, {cache:"no-store"}); const text = r.ok ? await r.text() : "This file is unavailable."; if (mine === latest) pre.textContent = text; }
    catch { if (mine === latest) pre.textContent = "This file is unavailable."; }
  };
  for (const file of prototype.files) { const b = button(file.path, () => show(file, b)); b.setAttribute("role", "tab"); buttons.push(b); tabs.append(b); }
  box.append(tabs, pre); if (buttons.length) show(prototype.files[0], buttons[0]); return box;
}
function frameFor(team, item) {
  const frame = node("iframe"); frame.title = "Team " + team + " artifact v" + item.version;
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
  frame.src = "p/" + team + "/" + item.version + "/index.html"; return frame;
}
function valid(item) { return item && item.ok && item.files.length && (SOURCE_KINDS.includes(item.kind) || item.files.some(f => f.path === "index.html")); }
function stageName(state, item) { return state.stages.find(s => s.index === item.stage)?.name || "Build"; }
function checkText(item) { const c = item.check; return !c || ["no browser", "disabled", "page check unavailable"].includes(c.reason) ? "not checked" : c.loaded && !c.reason && !c.exceptions.length && !c.consoleErrors.length && !c.failedRequests ? "loaded" : "errors"; }
function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
function createCard(team) {
  const card = node("article", undefined, "team"), title = node("h2", "Team " + team), seats = node("div", undefined, "team-seats"), progress = node("div", undefined, "progress"), status = node("p", "Waiting for the first build", "status"), ticker = node("p", "From the table · Waiting for a concept", "ticker"), live = node("div", undefined, "live"), badge = node("span", undefined, "build-badge"), metrics = node("div", undefined, "metrics"), versions = node("div", undefined, "versions"), tools = node("div", undefined, "tools"), diff = node("div"), approval = node("div", undefined, "approval"), transcript = node("div", undefined, "transcript");
  live.append(node("p", "Waiting for the first build", "placeholder")); badge.setAttribute("role", "status");
  card.append(title, seats, progress, status, ticker, live, badge, metrics, versions, tools, diff, approval);
  const column = node("section", undefined, "harness-column"), columnTitle = node("h2", "Team " + team); column.append(columnTitle, transcript); byId("team-transcripts").append(column); byId("artifacts").append(card);
  const result = { card, seats, progress, status, ticker, live, badge, metrics, versions, tools, diff, approval, column, columnTitle, transcript, key: "", stageKey: "", frame: null, pending: null }; cards.set(team, result); return result;
}
function displayArtifact(c, team, item) {
  const key = item ? String(item.version) : "empty";
  if (c.key === key) return;
  c.key = key;
  if (c.pending) { c.pending.remove(); c.pending = null; }
  if (!valid(item)) { c.live.replaceChildren(node("p", item?.error || "Waiting for the first build", "placeholder")); c.frame = null; return; }
  if (SOURCE_KINDS.includes(item.kind)) { c.live.replaceChildren(sourceView(team, item, item.version)); c.frame = null; return; }
  const frame = frameFor(team, item); frame.className = "incoming"; c.pending = frame;
  frame.addEventListener("load", () => {
    if (c.pending !== frame) return;
    if (c.frame) c.frame.remove();
    for (const child of [...c.live.children]) if (child !== frame) child.remove();
    frame.classList.remove("incoming"); c.frame = frame; c.pending = null;
    c.badge.textContent = "v" + item.version + " · " + stageName(current, item) + " · just now";
    c.badge.classList.add("fresh"); setTimeout(() => c.badge.classList.remove("fresh"), 4500);
  }, { once: true });
  c.live.append(frame);
}
function transcriptNode(item) {
  const entry = node("div", undefined, "entry");
  if (item.type === "turn") entry.append(node("strong", item.seat.name + " · " + item.round), node("p", item.text));
  else if (item.type === "stage") entry.append(node("strong", "Stage " + item.stage + "/" + item.of + " · " + item.name + " · " + item.status + (item.version ? " (v" + item.version + ")" : "")));
  else entry.append(node("strong", "Build · " + (item.title || "Artifact") + (item.version ? " · v" + item.version : "")), node("p", item.ok ? "Shipped " + item.files.length + " files" : item.error || "Build unavailable"));
  return entry;
}
function teamOf(state, seat) { return ["A", "B"].find(team => state.teams[team].includes(seat.id)) || seat.team; }
function renderTeam(state, team, web) {
  const c = cards.get(team) || createCard(team), history = state.history.filter(p => p.team === team), latest = history.filter(valid).at(-1), selected = history.find(p => p.version === selections.get(team)) || latest;
  const p = state.progress[team], m = state.metrics[team];
  c.card.classList.toggle("finished", !!m?.finishedAt); c.card.classList.toggle("chosen", (state.decision?.winner || state.end?.chosen?.team || state.end?.winner) === team);
  c.seats.replaceChildren(...state.seats.filter(s => teamOf(state, s) === team).map(s => { const row = node("div", undefined, "seat"); row.append(node("strong", s.name), node("span", s.provider + " / " + (s.model || "default"), "chip")); row.title = s.name + " · " + s.provider + " / " + (s.model || "default") + (s.reason ? " · " + s.reason : ""); return row; }));
  const stageEvents = state.transcript.filter(e => e.type === "stage" && e.team === team);
  const stageKey = JSON.stringify([state.stages, stageEvents, !!state.stopped]);
  if (c.stageKey !== stageKey) {
    c.stageKey = stageKey;
    c.progress.replaceChildren(...state.stages.map(s => {
      const e = stageEvents.filter(e => e.stage === s.index).at(-1), status = e?.status || "waiting";
      const segment = node("div", s.index + " · " + s.name, "segment " + status + (state.stopped ? " paused" : "")); segment.title = s.name + " · " + status; return segment;
    }));
  }
  setText(c.status, m?.finishedAt ? "Done in " + duration(m.elapsedMs) : state.stopped ? "Stopped at stage " + (p?.stage || 1) : p ? (p.status === "started" ? "Building stage " : "Stage ") + p.stage + " of " + p.of + " · " + p.name + (p.status === "started" ? "" : " · " + p.status) : "Waiting for the first build");
  const turns = state.turns.filter(t => teamOf(state, t.seat) === team && !/closing|dissent/i.test(t.round));
  const note = (latest ? turns.filter(t => /build|stage|revision/i.test(t.round)).at(-1) : turns.at(-1)) || turns.at(-1);
  setText(c.ticker, (latest ? "Build note · " : "From the table · ") + (note ? line(note.text) : latest?.title || "Waiting for a concept"));
  c.metrics.replaceChildren(...(m ? [short(m.inputTokens + m.outputTokens) + " tok" + (m.estimated ? " ≈" : ""), spendText(m.costUsd, m.unpricedTokens, false), duration(m.elapsedMs), plural(m.versions, "version"), plural(m.rewrites, "rewrite"), plural(m.failedTurns + m.validationFailures + m.pageErrors, "error")] : ["No metrics yet"]).map(t => node("span", t)));
  c.versions.replaceChildren(button("Live", () => { selections.delete(team); render(current); }, selections.has(team) ? "" : "active"), ...history.map(item => {
    const b = button("v" + item.version + " · " + stageName(state, item), () => { selections.set(team, item.version); render(current); }, selected?.version === item.version ? "active" : ""); b.title = checkText(item); b.setAttribute("aria-pressed", String(selected?.version === item.version)); return b;
  }));
  if (selections.has(team) && latest && latest.version > selected?.version) c.versions.append(node("span", "new version", "chip new-version"));
  const comparisonKey = String(comparisons.has(team)) + ":" + history.length;
  c.tools.replaceChildren();
  if (history.filter(valid).length > 1) c.tools.append(button(comparisons.has(team) ? "Hide diff" : "Current vs proposed", () => { comparisons.has(team) ? comparisons.delete(team) : comparisons.add(team); render(current); }));
  if (c.diffKey !== comparisonKey) {
    c.diffKey = comparisonKey; c.diff.replaceChildren();
    if (comparisons.has(team)) {
      const pair = node("div", undefined, "comparison"), items = history.filter(valid).slice(-2);
      items.forEach(item => { const box = node("div"); box.append(node("h3", "v" + item.version), SOURCE_KINDS.includes(item.kind) ? sourceView(team, item, item.version) : frameFor(team, item)); pair.append(box); });
      const diff = node("pre", "Loading diff…", "diff"); c.diff.append(pair, diff);
      fetch("diff/" + team + ".json", {cache:"no-store"}).then(r => r.ok ? r.json() : null).then(d => { diff.textContent = d ? d.path + " · v" + d.from + " → v" + d.to + "\n" + d.lines.map(l => (l.kind === "add" ? "+ " : l.kind === "remove" ? "- " : "  ") + l.text).join("\n") : "No diff available."; }).catch(() => { diff.textContent = "No diff available."; });
    }
  }
  c.live.classList.toggle("scaled", web && !selections.has(team));
  displayArtifact(c, team, selected);
  c.approval.replaceChildren();
  if (state.humanJudge && state.decision?.status === "awaiting" && state.controls.choose) {
    const b = button(!latest ? "No valid artifact to approve" : confirming === team ? "Confirm Team " + team + " wins" : "Approve Team " + team, () => { if (confirming === team) command("choose", team); else { confirming = team; render(current); } }, "approve"); b.disabled = !latest || busy; c.approval.append(b);
    if (confirming === team) c.approval.append(button("Cancel", () => { confirming = undefined; render(current); }));
  }
  c.transcript.replaceChildren(...state.transcript.filter(e => e.type === "turn" ? teamOf(state, e.seat) === team && !/closing|dissent/i.test(e.round) : e.team === team).map(transcriptNode));
  c.columnTitle.hidden = !web;
  if (web) { if (c.card.parentNode !== byId("artifacts")) byId("artifacts").append(c.card); }
  else if (c.card.parentNode !== c.column) c.column.prepend(c.card);
}
function efficiency(metrics) {
  const a = metrics.A, b = metrics.B; if (!a || !b) return "";
  const parts = [], faster = a.elapsedMs < b.elapsedMs ? "A" : "B", delta = Math.abs(a.elapsedMs - b.elapsedMs);
  if (a.finishedAt && b.finishedAt && delta >= 1000) parts.push("Team " + faster + " finished " + duration(delta) + " sooner");
  const at = a.inputTokens + a.outputTokens, bt = b.inputTokens + b.outputTokens, max = Math.max(at, bt);
  if (max && at !== bt) parts.push((parts.length && faster === (at < bt ? "A" : "B") ? "used " : "Team " + (at < bt ? "A" : "B") + " used ") + Math.round(Math.abs(at - bt) / max * 100) + "% fewer tokens");
  return parts.join(" and ");
}
function setView() { if (!current) return; const web = current.kind === "web", harness = !web || location.hash === "#harness"; byId("view-switch").hidden = !web; byId("artifacts").hidden = harness; byId("harness").hidden = !harness; byId("apps-tab").setAttribute("aria-pressed", String(!harness)); byId("harness-tab").setAttribute("aria-pressed", String(harness)); }
function render(state) {
  current = state;
  if (runId !== state.id) { runId = state.id; cards.forEach(c => { c.card.remove(); c.column.remove(); }); cards.clear(); selections.clear(); comparisons.clear(); confirming = undefined; }
  byId("topic").textContent = state.topic || "Waiting for the duel";
  const end = state.end, banner = byId("banner");
  banner.replaceChildren(); banner.hidden = !end && !state.stopped && !state.decision;
  if (state.stopped) banner.append(node("strong", state.usage.capReached ? "Stopped by spend cap. Raise --max-usd with roundtable duel --resume " + state.id + " to continue." : "Stopped. Resume continues from where it stopped."));
  else if (end) {
    banner.append(node("strong", end.winner === "tie" ? "It's a tie" : end.winner === "none" ? "No verdict" : "Team " + end.winner + " wins"), node("span", end.decidedBy === "human" ? "Chosen by you" : "Judges' tally A " + end.tally.A + " / B " + end.tally.B));
    const comparison = efficiency(end.metrics || state.metrics); if (comparison) banner.append(node("span", comparison));
    if (end.chosen) banner.append(node("code", end.chosen.dir));
  } else if (state.decision) banner.append(node("strong", state.decision.status === "awaiting" ? "Waiting for you to choose the winner" : "You chose Team " + state.decision.winner));
  byId("header-controls").replaceChildren();
  if (state.controls.stop) { const b = button("Stop", () => command("stop"), "stop"); b.disabled = busy; byId("header-controls").append(b); }
  if (state.controls.resume && !state.usage.capReached) { const b = button("Resume", () => command("resume")); b.disabled = busy; (state.stopped ? banner : byId("header-controls")).append(b); }
  for (const team of ["A", "B"]) renderTeam(state, team, state.kind === "web");
  byId("judges").replaceChildren(...state.turns.filter(t => teamOf(state, t.seat) !== "A" && teamOf(state, t.seat) !== "B" && !/closing/i.test(t.round)).map(transcriptNode));
  byId("closings").replaceChildren(...state.turns.filter(t => /closing/i.test(t.round)).map(transcriptNode));
  byId("verdicts").replaceChildren(...state.assessments.map(item => { const card = node("article", undefined, "verdict"); card.dataset.verdict = item.verdict; card.append(node("strong", item.judge.name + " · Team " + item.team + (item.version ? " · v" + item.version : "") + " · " + item.verdict), node("p", item.reason)); return card; }));
  byId("dissents").replaceChildren(...state.dissents.map(item => node("article", item.seat.name + (item.team ? " · Team " + item.team : "") + "\n" + item.text, "entry")));
  if (state.browser) { const shot = state.browser, image = byId("browser-shot"); byId("browser-note").textContent = "Team " + shot.team + " · v" + shot.version; const src = "shot/" + shot.team + "/" + shot.version + ".png"; if (image.getAttribute("src") !== src) image.src = src; image.hidden = false; }
  const teamSpend = Object.values(state.metrics).reduce((n, m) => n + (m?.costUsd || 0), 0);
  byId("spend").textContent = (state.usage.capUsd !== undefined ? "$" + (state.usage.spentUsd ?? state.usage.totalCostUsd).toFixed(4) + " of $" + state.usage.capUsd + " cap" + (state.usage.capReached ? " · stopped by spend cap" : "") : "Estimated spend: " + spendText(Math.max(state.usage.totalCostUsd || 0, teamSpend), state.usage.totalUnpricedTokens, true)); setView();
}
byId("apps-tab").addEventListener("click", () => { location.hash = ""; setView(); });
byId("harness-tab").addEventListener("click", () => { location.hash = "harness"; setView(); });
window.addEventListener("hashchange", setView);
/* Dev-server frames use only the origins present when this page received its CSP. */
let framed = null;
async function previews() {
  try {
    const response = await fetch("previews.json", {cache:"no-store"}); if (!response.ok) return; const list = await response.json();
    if (framed === null) framed = new Set(list.map(item => item.origin));
    const holder = byId("preview-frames"), wanted = list.filter(item => framed.has(item.origin)); byId("previews").hidden = !list.length;
    byId("preview-note").textContent = wanted.length < list.length ? "A new preview is running: reload this page to show it." : "";
    for (const old of [...holder.children]) if (!wanted.some(item => item.id === old.dataset.id)) old.remove();
    for (const item of wanted) {
      if ([...holder.children].some(child => child.dataset.id === item.id)) continue;
      const figure = node("figure"); figure.dataset.id = item.id; figure.append(node("figcaption", item.id + " · " + item.label + " · " + item.origin));
      const frame = node("iframe"); frame.setAttribute("sandbox", "allow-scripts allow-forms"); frame.referrerPolicy = "no-referrer"; frame.title = "Preview " + item.id; frame.src = item.origin + "/"; figure.append(frame); holder.append(figure);
    }
  } catch { /* The room keeps working without previews. */ }
}
async function poll() { previews(); try { const response = await fetch("state.json", {cache:"no-store"}); if (response.ok) render(await response.json()); } catch { byId("control-note").textContent = "Room disconnected. The last artifacts remain available."; } finally { setTimeout(poll, 1000); } }
poll();`;
